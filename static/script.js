// Демонстрационные данные. Позже заменим их запросами к серверу и базе данных.
let products = [];

async function loadProducts() {
  try {
    const response = await fetch("/api/products");

    if (!response.ok) {
      throw new Error("Не удалось загрузить товары");
    }

    products = await response.json();

    renderStock();
    await loadMovements();
  } catch (error) {
    console.error(error);
    toast("Не удалось загрузить товары из базы данных.");
  }
}

let movements = [
  { date: "29.10.2026, 10:42", type: "Приход", product: "Кабель 3×1.5", quantity: "+100 м", details: "Поставка от поставщика" },
  { date: "29.10.2026, 11:10", type: "Выдача", product: "Кабель 3×1.5", quantity: "−30,5 м", details: "Юнусабад, кв. 12" }
];

const pageMeta = {
  stock: ["Остатки", "Обзор товаров на складе"],
  products: ["Товары", "Список товаров и их параметры"],
  incoming: ["Приход", "Регистрация поступления на склад"],
  outgoing: ["Выдача", "Выдача товаров на объекты"],
  history: ["История", "Журнал складских операций"]
};

// Права доступа для каждой роли
let currentUserRole = null;

const rolePermissions = {
  director: ["stock", "products", "incoming", "outgoing", "history"],
  storekeeper: ["stock", "products", "incoming", "outgoing", "history"],
  manager: ["stock", "products", "history"]
};

function applyRolePermissions(role) {
  currentUserRole = role;

  const allowedPages = rolePermissions[role] || ["stock"];

  // Скрываем недоступные пункты меню
  document.querySelectorAll(".nav-item").forEach(button => {
    const page = button.dataset.page;
    button.classList.toggle("hidden", !allowedPages.includes(page));
  });

  // Скрываем недоступные страницы
  ["stock", "products", "incoming", "outgoing", "history"].forEach(page => {
    const section = document.getElementById(`${page}Page`);

    if (section) {
      section.classList.toggle("hidden", !allowedPages.includes(page));
    }
  });

  // Добавлять товары может только директор
  const canAddProducts = role === "director";

  ["addProductButton", "addProductButton2"].forEach(id => {
    const button = document.getElementById(id);

    if (button) {
      button.classList.toggle("hidden", !canAddProducts);
    }
  });
}

// Форматирование денежных сумм
const money = (value, currency) => new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
}).format(value) + (
  currency === "UZS" ? " сум" :
  currency === "USD" ? " $" : " ¥"
);

// Форматирование количества
const quantity = (value) => new Intl.NumberFormat("ru-RU", {
  maximumFractionDigits: 2
}).format(value);

// Отображение остатков товаров
function renderStock() {
  const query = document.getElementById("searchInput").value.trim().toLowerCase();
  const currency = document.getElementById("currencyFilter").value;

  const visible = products.filter(p =>
    !p.archived &&
    p.name.toLowerCase().includes(query) &&
    (currency === "all" || p.currency === currency)
  );

  document.getElementById("productsTable").innerHTML = visible.map((p, i) => `
    <tr>
      <td>${i + 1}</td>
      <td class="product-name">${escapeHTML(p.name)}</td>
      <td><span class="unit-pill">${p.unit}</span></td>
      <td>${quantity(p.stock)}</td>
      <td>${money(p.price, p.currency)}</td>
      <td><span class="currency">${p.currency}</span></td>
      <td><strong>${money(roundMoney(p.stock * p.price), p.currency)}</strong></td>
    </tr>
  `).join("");

  document.getElementById("emptyState").classList.toggle("hidden", visible.length > 0);

  // Считаем итоги отдельно по каждой валюте
  const totals = { UZS: 0, USD: 0, CNY: 0 };

  products.filter(p => !p.archived).forEach(p => {
    totals[p.currency] += p.stock * p.price;
  });

  document.getElementById("totalUZS").textContent = money(roundMoney(totals.UZS), "UZS");
  document.getElementById("totalUSD").textContent = money(roundMoney(totals.USD), "USD");
  document.getElementById("totalCNY").textContent = money(roundMoney(totals.CNY), "CNY");

  document.getElementById("statProducts").textContent =
    products.filter(p => !p.archived).length;

  document.getElementById("statUnits").textContent = quantity(
    products.filter(p => !p.archived).reduce((sum, p) => sum + p.stock, 0)
  );

  document.getElementById("statActive").textContent =
    products.filter(p => !p.archived).length;

  renderAllProducts();
  renderProductOptions();
}

// Отображение полного списка товаров
function renderAllProducts() {
  const input = document.getElementById("productSearchInput");
  if (!input) return;

  const query = input.value.trim().toLowerCase();

  const visible = products.filter(p =>
    p.name.toLowerCase().includes(query)
  );

  document.getElementById("allProductsTable").innerHTML = visible.map((p, i) => `
    <tr>
      <td>${i + 1}</td>
      <td class="product-name">${escapeHTML(p.name)}</td>
      <td>${p.unit}</td>
      <td>${money(p.price, p.currency)}</td>
      <td>${p.currency}</td>
      <td><span class="unit-pill">${p.archived ? "В архиве" : "Активен"}</span></td>
    </tr>
  `).join("");
}

// Заполняем выпадающие списки товарами
function renderProductOptions() {
  ["incomingProduct", "outgoingProduct"].forEach(id => {
    const select = document.getElementById(id);
    const previous = select.value;

    select.innerHTML = products
      .filter(p => !p.archived)
      .map(p => `
        <option value="${p.id}">
          ${escapeHTML(p.name)} — остаток ${quantity(p.stock)} ${p.unit}
        </option>
      `).join("");

    if (previous) select.value = previous;
  });
}

// Отображение истории операций
function renderHistory() {
  const body = document.getElementById("historyTable");

  body.innerHTML = movements.map(m => {
    const date = new Date(m.created_at.replace(" ", "T") + "Z")
      .toLocaleString("ru-RU");

    const isIncoming = m.type === "IN";
    const amount = `${isIncoming ? "+" : "−"}${quantity(m.quantity)} ${m.unit}`;
    const details = [
      m.object_name,
      m.comment
    ].filter(Boolean).join(" · ") || "—";

    return `
      <tr>
        <td>${escapeHTML(date)}</td>
        <td><span class="unit-pill">${isIncoming ? "Приход" : "Выдача"}</span></td>
        <td class="product-name">${escapeHTML(m.product)}</td>
        <td>${amount}</td>
        <td>${escapeHTML(details)}</td>
      </tr>
    `;
  }).join("");

  document.getElementById("historyEmpty").classList.toggle(
    "hidden", movements.length > 0
  );
}

// Округление денежных значений до двух знаков
function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// Защита текста при вставке в HTML
function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

// Переключение страниц сайта
function showPage(page) {
    const allowedPages = rolePermissions[currentUserRole] || ["stock"];

  if (!allowedPages.includes(page)) {
    toast("У вас нет доступа к этому разделу.");
    return;
  }
  document.querySelectorAll(".nav-item").forEach(button => {
    button.classList.toggle("active", button.dataset.page === page);
  });

  ["stock", "products", "incoming", "outgoing", "history"].forEach(name => {
    const section = document.getElementById(`${name}Page`);
    section.classList.toggle("hidden", name !== page);
  });

  document.getElementById("pageTitle").textContent = pageMeta[page][0];
  document.getElementById("pageSubtitle").textContent = pageMeta[page][1];

  document.getElementById("sidebar").classList.remove("open");

  if (page === "history") renderHistory();
}

// Всплывающие сообщения
function toast(message) {
  const el = document.getElementById("toast");

  el.textContent = message;
  el.classList.add("show");

  clearTimeout(toast.timer);

  toast.timer = setTimeout(() => {
    el.classList.remove("show");
  }, 2800);
}

// Окно добавления товара
const dialog = document.getElementById("productDialog");

async function loadMovements() {
  const response = await fetch("/api/movements");

  if (!response.ok) {
    throw new Error("Не удалось загрузить историю операций.");
  }

  movements = await response.json();
  renderHistory();
}

function openProductDialog() {
  document.getElementById("productForm").reset();
  document.getElementById("formError").classList.add("hidden");
  dialog.showModal();
}

// Обработчики навигации
document.querySelectorAll(".nav-item").forEach(button => {
  button.addEventListener("click", () => {
    showPage(button.dataset.page);
  });
});

// Мобильное меню
document.getElementById("menuButton").addEventListener("click", () => {
  document.getElementById("sidebar").classList.toggle("open");
});

// Поиск и фильтрация
document.getElementById("searchInput").addEventListener("input", renderStock);
document.getElementById("currencyFilter").addEventListener("change", renderStock);
document.getElementById("productSearchInput").addEventListener("input", renderAllProducts);

// Кнопки управления окном товара
document.getElementById("addProductButton").addEventListener("click", openProductDialog);
document.getElementById("addProductButton2").addEventListener("click", openProductDialog);
document.getElementById("closeDialog").addEventListener("click", () => dialog.close());
document.getElementById("cancelDialog").addEventListener("click", () => dialog.close());

// Добавление нового товара

document.getElementById("productForm").addEventListener("submit", async event => {
  event.preventDefault();

  const name = document.getElementById("newName").value.trim();
  const unit = document.getElementById("newUnit").value;
  const price = Number(document.getElementById("newPrice").value);
  const currency = document.getElementById("newCurrency").value;
  const stock = Number(document.getElementById("newStock").value);
  const error = document.getElementById("formError");
  const submitButton = event.submitter;

  if (!name || !Number.isFinite(price) || price < 0 ||
      !Number.isFinite(stock) || stock < 0) {
    error.textContent = "Проверьте название, цену и остаток.";
    error.classList.remove("hidden");
    return;
  }

  if (unit === "шт." && !Number.isInteger(stock)) {
    error.textContent = "Количество штук должно быть целым числом.";
    error.classList.remove("hidden");
    return;
  }

  submitButton.disabled = true;

  try {
    const response = await fetch("/api/products", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ name, unit, price, currency, stock })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Не удалось сохранить товар.");
    }

    await loadProducts();
    dialog.close();
    toast("Товар сохранён в базе данных.");
  } catch (error) {
    document.getElementById("formError").textContent = error.message;
    document.getElementById("formError").classList.remove("hidden");
  } finally {
    submitButton.disabled = false;
  }
});



async function submitMovement(event, type) {
  event.preventDefault();

  const incoming = type === "IN";
  const productId = Number(document.getElementById(
    incoming ? "incomingProduct" : "outgoingProduct"
  ).value);

  const amount = Number(document.getElementById(
    incoming ? "incomingQuantity" : "outgoingQuantity"
  ).value);

  const comment = document.getElementById(
    incoming ? "incomingComment" : "outgoingComment"
  ).value.trim();

  const objectName = incoming ? "" :
    document.getElementById("outgoingObject").value.trim();

  const product = products.find(p => p.id === productId);

  if (
    !product ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    (product.unit === "шт." && !Number.isInteger(amount)) ||
    (!incoming && !objectName)
  ) {
    toast("Проверьте товар, количество и объект.");
    return;
  }

  const form = event.currentTarget;
  const submitButton = form.querySelector('[type="submit"]');

  if (submitButton) submitButton.disabled = true;

  try {
    const response = await fetch(
      incoming ? "/api/movements/incoming" : "/api/movements/outgoing",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          product_id: productId,
          quantity: amount,
          object_name: objectName,
          comment
        })
      }
    );

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Не удалось сохранить операцию.");
    }

    // Обновляем товары и историю данными из базы
    await loadProducts();

    form.reset();
    toast(incoming
      ? "Приход сохранён в базе данных."
      : "Выдача сохранена в базе данных."
    );
  } catch (error) {
    console.error(error);
    toast(error.message || "Ошибка сохранения операции.");
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}

document.getElementById("incomingForm").addEventListener(
  "submit", event => submitMovement(event, "IN")
);

document.getElementById("outgoingForm").addEventListener(
  "submit", event => submitMovement(event, "OUT")
);




async function loadCurrentUser() {
  const nameElement = document.getElementById("currentUserName");
  const roleElement = document.getElementById("currentUserRole");
  const avatarElement = document.getElementById("userAvatar");

  try {
    console.log("Загружаем данные аккаунта...");

    const response = await fetch("/api/me");
    console.log("Ответ /api/me:", response.status);

    if (response.status === 401) {
      window.location.href = "/login";
      return;
    }

    if (!response.ok) {
      throw new Error(`Ошибка сервера: ${response.status}`);
    }

    const user = await response.json();

    const roleNames = {
      director: "Директор",
      storekeeper: "Кладовщик",
      manager: "Менеджер"
    };

    nameElement.textContent = user.username;
    roleElement.textContent = roleNames[user.role] || user.role;
    avatarElement.textContent =
      user.username.charAt(0).toUpperCase();
      applyRolePermissions(user.role);

    console.log("Аккаунт загружен:", user.username, user.role);

  } catch (error) {
    console.error("Ошибка загрузки аккаунта:", error);
    nameElement.textContent = "Ошибка загрузки";
    roleElement.textContent = "Проверь соединение с сервером";
  }
}

// Загружаем аккаунт и товары при открытии сайта
loadCurrentUser();
loadProducts();