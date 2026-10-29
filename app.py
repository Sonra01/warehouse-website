
import os
import sys
import sqlite3
from pathlib import Path
from math import isfinite
from functools import wraps
from getpass import getpass

from flask import (
    Flask, jsonify, render_template, request,
    session, redirect, url_for
)
from werkzeug.security import (
    generate_password_hash, check_password_hash
)

app = Flask(__name__)
app.secret_key = os.environ.get(
    "FLASK_SECRET_KEY", "local-development-key-change-before-deployment"
)

DB_PATH = Path(__file__).with_name("warehouse.db")

ROLES = ("director", "storekeeper", "manager")


def get_db():
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def init_db():
    with get_db() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL CHECK (
                    role IN ('director', 'storekeeper', 'manager')
                )
            );

            CREATE TABLE IF NOT EXISTS products (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL CHECK (length(trim(name)) > 0),
                unit TEXT NOT NULL CHECK (unit IN ('шт.', 'м')),
                price NUMERIC NOT NULL CHECK (price >= 0),
                currency TEXT NOT NULL CHECK (
                    currency IN ('UZS', 'USD', 'CNY')
                ),
                stock NUMERIC NOT NULL DEFAULT 0 CHECK (stock >= 0),
                archived INTEGER NOT NULL DEFAULT 0
                    CHECK (archived IN (0, 1))
            );

            CREATE TABLE IF NOT EXISTS stock_movements (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                product_id INTEGER NOT NULL,
                user_id INTEGER,
                type TEXT NOT NULL CHECK (
                    type IN ('IN', 'OUT', 'CANCEL')
                ),
                quantity NUMERIC NOT NULL CHECK (quantity > 0),
                object_name TEXT,
                comment TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                cancelled_at TEXT,
                cancelled_by INTEGER,
                FOREIGN KEY (product_id) REFERENCES products(id),
                FOREIGN KEY (user_id) REFERENCES users(id),
                FOREIGN KEY (cancelled_by) REFERENCES users(id)
            );
        """)

        count = db.execute(
            "SELECT COUNT(*) FROM products"
        ).fetchone()[0]

        if count == 0:
            db.executemany("""
                INSERT INTO products
                    (name, unit, price, currency, stock)
                VALUES (?, ?, ?, ?, ?)
            """, [
                ("Кабель 3×1.5", "м", 0.80, "USD", 69.5),
                ("Выключатель Livolo белый", "шт.", 12.50, "USD", 45),
                ("Датчик движения", "шт.", 150000, "UZS", 18),
                ("Розетка двойная", "шт.", 9000, "UZS", 27),
                ("Кабель витая пара", "м", 2.20, "USD", 100),
            ])


# ---------- Проверка авторизации и ролей ----------

def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("user_id"):
            if request.path.startswith("/api/"):
                return jsonify({"error": "Требуется вход в систему."}), 401
            return redirect(url_for("login"))

        return view(*args, **kwargs)

    return wrapped


def roles_required(*allowed_roles):
    def decorator(view):
        @wraps(view)
        @login_required
        def wrapped(*args, **kwargs):
            if session.get("role") not in allowed_roles:
                return jsonify({
                    "error": "У вас недостаточно прав для этого действия."
                }), 403

            return view(*args, **kwargs)

        return wrapped

    return decorator


# ---------- Страницы и вход ----------

@app.route("/")
@login_required
def index():
    return render_template("index.html")


@app.route("/login", methods=["GET", "POST"])
def login():
    if session.get("user_id"):
        return redirect(url_for("index"))

    error = None

    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")

        with get_db() as db:
            user = db.execute("""
                SELECT id, username, password_hash, role
                FROM users
                WHERE username = ?
            """, (username,)).fetchone()

        if user and check_password_hash(user["password_hash"], password):
            session.clear()
            session["user_id"] = user["id"]
            session["username"] = user["username"]
            session["role"] = user["role"]
            return redirect(url_for("index"))

        error = "Неверный логин или пароль."

    return render_template("login.html", error=error)


@app.route("/logout", methods=["POST"])
@login_required
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/api/me", methods=["GET"])
@login_required
def current_user():
    return jsonify({
        "id": session["user_id"],
        "username": session["username"],
        "role": session["role"]
    })


# ---------- Управление пользователями: только директор ----------

@app.route("/api/users", methods=["GET"])
@roles_required("director")
def get_users():
    with get_db() as db:
        rows = db.execute("""
            SELECT id, username, role
            FROM users
            ORDER BY id
        """).fetchall()

    return jsonify([dict(row) for row in rows])


@app.route("/api/users", methods=["POST"])
@roles_required("director")
def create_user():
    data = request.get_json(silent=True) or {}

    username = data.get("username")
    password = data.get("password")
    role = data.get("role")

    if not isinstance(username, str) or not username.strip():
        return jsonify({"error": "Укажите логин."}), 400

    if len(username.strip()) > 80:
        return jsonify({"error": "Логин слишком длинный."}), 400

    if not isinstance(password, str) or len(password) < 8:
        return jsonify({
            "error": "Пароль должен содержать не менее 8 символов."
        }), 400

    if role not in ("storekeeper", "manager", "director"):
        return jsonify({"error": "Недопустимая роль."}), 400

    try:
        with get_db() as db:
            cursor = db.execute("""
                INSERT INTO users (username, password_hash, role)
                VALUES (?, ?, ?)
            """, (
                username.strip(),
                generate_password_hash(password),
                role
            ))
            user_id = cursor.lastrowid

    except sqlite3.IntegrityError:
        return jsonify({"error": "Такой логин уже существует."}), 409

    return jsonify({
        "id": user_id,
        "username": username.strip(),
        "role": role
    }), 201


# ---------- Товары ----------

@app.route("/api/products", methods=["GET"])
@roles_required("director", "storekeeper", "manager")
def get_products():
    with get_db() as db:
        rows = db.execute("""
            SELECT id, name, unit, stock, price, currency, archived
            FROM products
            ORDER BY id
        """).fetchall()

    return jsonify([dict(row) for row in rows])


@app.route("/api/products", methods=["POST"])
@roles_required("director")
def add_product():
    data = request.get_json(silent=True) or {}

    name = data.get("name")
    unit = data.get("unit")
    currency = data.get("currency")

    if not isinstance(name, str) or not name.strip():
        return jsonify({"error": "Введите название товара."}), 400

    if unit not in ("шт.", "м"):
        return jsonify({"error": "Недопустимая единица измерения."}), 400

    if currency not in ("UZS", "USD", "CNY"):
        return jsonify({"error": "Недопустимая валюта."}), 400

    try:
        price = float(data["price"])
        stock = float(data.get("stock", 0))

        if not isfinite(price) or price < 0:
            raise ValueError()

        if not isfinite(stock) or stock < 0:
            raise ValueError()

        if unit == "шт." and not stock.is_integer():
            return jsonify({
                "error": "Количество штук должно быть целым."
            }), 400

    except (KeyError, TypeError, ValueError, OverflowError):
        return jsonify({"error": "Проверьте цену и остаток."}), 400

    with get_db() as db:
        cursor = db.execute("""
            INSERT INTO products (name, unit, price, currency, stock)
            VALUES (?, ?, ?, ?, ?)
        """, (name.strip(), unit, price, currency, stock))

        row = db.execute("""
            SELECT id, name, unit, stock, price, currency, archived
            FROM products WHERE id = ?
        """, (cursor.lastrowid,)).fetchone()

    return jsonify(dict(row)), 201


# ---------- История операций ----------

@app.route("/api/movements", methods=["GET"])
@roles_required("director", "storekeeper", "manager")
def get_movements():
    with get_db() as db:
        rows = db.execute("""
            SELECT
                m.id, m.product_id, p.name AS product,
                m.type, m.quantity, p.unit,
                m.object_name, m.comment, m.created_at
            FROM stock_movements AS m
            JOIN products AS p ON p.id = m.product_id
            WHERE m.cancelled_at IS NULL
            ORDER BY m.id DESC
        """).fetchall()

    return jsonify([dict(row) for row in rows])


# ---------- Приход и выдача ----------

def process_movement(movement_type):
    data = request.get_json(silent=True) or {}

    try:
        product_id = int(data["product_id"])
        amount = float(data["quantity"])

        if not isfinite(amount) or amount <= 0:
            raise ValueError()

    except (KeyError, TypeError, ValueError, OverflowError):
        return jsonify({"error": "Проверьте товар и количество."}), 400

    object_name = str(data.get("object_name") or "").strip()
    comment = str(data.get("comment") or "").strip()

    with get_db() as db:
        product = db.execute("""
            SELECT id, unit, stock FROM products
            WHERE id = ? AND archived = 0
        """, (product_id,)).fetchone()

        if product is None:
            return jsonify({"error": "Товар не найден или в архиве."}), 404

        if product["unit"] == "шт." and not amount.is_integer():
            return jsonify({
                "error": "Количество штук должно быть целым."
            }), 400

        if movement_type == "OUT" and not object_name:
            return jsonify({"error": "Укажите объект выдачи."}), 400

        if movement_type == "OUT" and amount > product["stock"]:
            return jsonify({
                "error": f"На складе только {product['stock']} {product['unit']}."
            }), 400

        if movement_type == "IN":
            db.execute("""
                UPDATE products SET stock = stock + ? WHERE id = ?
            """, (amount, product_id))
        else:
            cursor = db.execute("""
                UPDATE products SET stock = stock - ?
                WHERE id = ? AND stock >= ?
            """, (amount, product_id, amount))

            if cursor.rowcount == 0:
                return jsonify({
                    "error": "Недостаточно товара на складе."
                }), 400

        cursor = db.execute("""
            INSERT INTO stock_movements
                (product_id, user_id, type, quantity, object_name, comment)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (
            product_id,
            session["user_id"],
            movement_type,
            amount,
            object_name or None,
            comment or None
        ))

        row = db.execute("""
            SELECT m.id, m.product_id, p.name AS product,
                   m.type, m.quantity, p.unit,
                   m.object_name, m.comment, m.created_at
            FROM stock_movements AS m
            JOIN products AS p ON p.id = m.product_id
            WHERE m.id = ?
        """, (cursor.lastrowid,)).fetchone()

    return jsonify(dict(row)), 201


@app.route("/api/movements/incoming", methods=["POST"])
@roles_required("director", "storekeeper")
def add_incoming():
    return process_movement("IN")


@app.route("/api/movements/outgoing", methods=["POST"])
@roles_required("director", "storekeeper")
def add_outgoing():
    return process_movement("OUT")


# ---------- Создание первого директора ----------

def create_director():
    username = input("Логин первого директора: ").strip()

    if not username:
        print("Логин не может быть пустым.")
        return

    password = getpass("Пароль (не менее 8 символов): ")
    confirmation = getpass("Повторите пароль: ")

    if len(password) < 8:
        print("Пароль должен содержать не менее 8 символов.")
        return

    if password != confirmation:
        print("Пароли не совпадают.")
        return

    try:
        with get_db() as db:
            db.execute("""
                INSERT INTO users (username, password_hash, role)
                VALUES (?, ?, 'director')
            """, (username, generate_password_hash(password)))

        print("Учётная запись директора создана.")

    except sqlite3.IntegrityError:
        print("Такой логин уже существует.")


if __name__ == "__main__":
    init_db()

    if len(sys.argv) > 1 and sys.argv[1] == "create-director":
        create_director()
    else:
        app.run(debug=True)
