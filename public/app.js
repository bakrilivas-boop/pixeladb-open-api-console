const state = {
  cdk: "",
  tasks: new Map(),
  latestResponse: {},
  autoTimer: null,
};

const PIXEL_API_BASE_URL = "https://okey188.com/api/v1/open";
const LOCAL_PROXY_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const FORCE_PAGES_MODE = new URLSearchParams(window.location.search).get("mode") === "pages";
const USE_LOCAL_PROXY = LOCAL_PROXY_HOSTS.has(window.location.hostname) && !FORCE_PAGES_MODE;
const CORS_HELP =
  `If this is running on GitHub Pages, ask the PixelADB server owner to add ${window.location.origin} to CORS_ORIGINS.`;

const els = {
  apiStatus: document.querySelector("#apiStatus"),
  apiBase: document.querySelector("#apiBase"),
  serverCdk: document.querySelector("#serverCdk"),
  cdkInput: document.querySelector("#cdkInput"),
  rememberCdk: document.querySelector("#rememberCdk"),
  taskType: document.querySelector("#taskType"),
  accountsInput: document.querySelector("#accountsInput"),
  submitBtn: document.querySelector("#submitBtn"),
  sampleBtn: document.querySelector("#sampleBtn"),
  clearBtn: document.querySelector("#clearBtn"),
  taskIdInput: document.querySelector("#taskIdInput"),
  queryBtn: document.querySelector("#queryBtn"),
  cancelBtn: document.querySelector("#cancelBtn"),
  retryBtn: document.querySelector("#retryBtn"),
  autoRefresh: document.querySelector("#autoRefresh"),
  taskList: document.querySelector("#taskList"),
  responseOutput: document.querySelector("#responseOutput"),
  copyResponseBtn: document.querySelector("#copyResponseBtn"),
};

const sampleAccounts = [
  {
    email: "user@example.com",
    password: "password",
    totp: "BASE32SECRET",
    recovery: "",
  },
];

init();

function init() {
  const remembered = sessionStorage.getItem("pixeladb.cdk") || "";
  if (remembered) {
    els.cdkInput.value = remembered;
    els.rememberCdk.checked = true;
  }

  els.accountsInput.value = JSON.stringify(sampleAccounts, null, 2);
  bindEvents();
  renderTasks();
  refreshHealth();
}

function bindEvents() {
  els.cdkInput.addEventListener("input", () => {
    if (els.rememberCdk.checked) sessionStorage.setItem("pixeladb.cdk", els.cdkInput.value);
  });

  els.rememberCdk.addEventListener("change", () => {
    if (els.rememberCdk.checked) {
      sessionStorage.setItem("pixeladb.cdk", els.cdkInput.value);
    } else {
      sessionStorage.removeItem("pixeladb.cdk");
    }
  });

  els.sampleBtn.addEventListener("click", () => {
    els.accountsInput.value = JSON.stringify(sampleAccounts, null, 2);
  });

  els.clearBtn.addEventListener("click", () => {
    els.accountsInput.value = "";
    setResponse({});
  });

  els.submitBtn.addEventListener("click", () => withBusy(els.submitBtn, submitTasks));
  els.queryBtn.addEventListener("click", () => withBusy(els.queryBtn, () => queryTask(getTaskId())));
  els.cancelBtn.addEventListener("click", () => withBusy(els.cancelBtn, () => cancelTask(getTaskId())));
  els.retryBtn.addEventListener("click", () => withBusy(els.retryBtn, () => retryTask(getTaskId())));
  els.copyResponseBtn.addEventListener("click", copyResponse);

  els.autoRefresh.addEventListener("change", () => {
    if (els.autoRefresh.checked) {
      state.autoTimer = window.setInterval(refreshKnownTasks, 5000);
      refreshKnownTasks();
    } else {
      window.clearInterval(state.autoTimer);
      state.autoTimer = null;
    }
  });
}

async function refreshHealth() {
  if (!USE_LOCAL_PROXY) {
    els.apiBase.textContent = PIXEL_API_BASE_URL;
    els.serverCdk.textContent = "Browser only";
    els.apiStatus.classList.remove("bad");
    els.apiStatus.classList.add("ok");
    els.apiStatus.lastElementChild.textContent = "GitHub Pages mode";
    setResponse({
      mode: "github_pages",
      apiBaseUrl: PIXEL_API_BASE_URL,
      note: CORS_HELP,
    });
    return;
  }

  try {
    const data = await requestJson("/api/health");
    els.apiBase.textContent = data.apiBaseUrl || "-";
    els.serverCdk.textContent = data.hasDefaultCdk ? "Configured" : "Not configured";
    els.apiStatus.classList.remove("bad");
    els.apiStatus.classList.add("ok");
    els.apiStatus.lastElementChild.textContent = "Proxy ready";
  } catch (error) {
    els.apiStatus.classList.remove("ok");
    els.apiStatus.classList.add("bad");
    els.apiStatus.lastElementChild.textContent = "Proxy unavailable";
    setResponse(formatError(error));
  }
}

async function submitTasks() {
  const accounts = parseAccounts(els.accountsInput.value);
  const payload = {
    cdk: getCdk(),
    type: els.taskType.value,
    accounts,
  };

  const data = USE_LOCAL_PROXY
    ? await requestJson("/api/tasks", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    : await requestPixelApi("POST", "/tasks", payload.cdk, {
        type: payload.type,
        accounts: payload.accounts,
      });

  setResponse(data);

  if (Array.isArray(data?.task_ids)) {
    for (const taskId of data.task_ids) {
      state.tasks.set(String(taskId), {
        id: taskId,
        status: "created",
        type: els.taskType.value,
        email: accounts.find(Boolean)?.email || "",
      });
    }
    renderTasks();
    toast(`Created ${data.task_ids.length} task(s).`);
  }
}

async function queryTask(taskId) {
  const data = USE_LOCAL_PROXY
    ? await requestJson(`/api/tasks/${taskId}?${new URLSearchParams({ cdk: getCdk() })}`)
    : await requestPixelApi("GET", `/tasks/${taskId}`, getCdk());
  upsertTask(data);
  setResponse(data);
  renderTasks();
  return data;
}

async function cancelTask(taskId) {
  const ok = window.confirm(`Cancel task ${taskId}?`);
  if (!ok) return;

  const data = USE_LOCAL_PROXY
    ? await requestJson(`/api/tasks/${taskId}/cancel`, {
        method: "POST",
        body: JSON.stringify({ cdk: getCdk() }),
      })
    : await requestPixelApi("POST", `/tasks/${taskId}/cancel`, getCdk());
  upsertTask(data);
  setResponse(data);
  renderTasks();
}

async function retryTask(taskId) {
  const ok = window.confirm(`Retry task ${taskId}?`);
  if (!ok) return;

  const data = USE_LOCAL_PROXY
    ? await requestJson(`/api/tasks/${taskId}/retry`, {
        method: "POST",
        body: JSON.stringify({ cdk: getCdk() }),
      })
    : await requestPixelApi("POST", `/tasks/${taskId}/retry`, getCdk());
  upsertTask(data);
  setResponse(data);
  renderTasks();
}

async function refreshKnownTasks() {
  const ids = [...state.tasks.keys()];
  for (const id of ids) {
    try {
      await queryTask(id);
    } catch (error) {
      setResponse(formatError(error));
      toast(`Refresh failed for task ${id}.`, "error");
    }
  }
}

function parseAccounts(raw) {
  const text = raw.trim();
  if (!text) throw new Error("Enter at least one account.");

  if (text.startsWith("[") || text.startsWith("{")) {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.accounts)) return parsed.accounts;
    throw new Error("JSON must be an array or an object with accounts.");
  }

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const columns = splitAccountLine(line);
      if (columns.length < 3) {
        throw new Error(`Line ${index + 1} must contain email, password, and totp.`);
      }
      return {
        email: columns[0],
        password: columns[1],
        totp: columns[2],
        recovery: columns.slice(3).join(","),
      };
    });
}

function splitAccountLine(line) {
  const delimiter = [",", "\t", "|", ";"].find((candidate) => line.includes(candidate)) || ",";
  return line.split(delimiter).map((item) => item.trim());
}

async function requestJson(url, options = {}) {
  const headers = {
    Accept: "application/json",
    ...(options.headers || {}),
  };

  if (options.body) headers["Content-Type"] = "application/json";

  const response = await fetch(url, { ...options, headers });
  const text = await response.text();
  const data = parseResponse(text);

  if (!response.ok) {
    const error = new Error(data?.message || `Request failed with HTTP ${response.status}.`);
    error.response = data;
    error.status = response.status;
    throw error;
  }

  return data;
}

async function requestPixelApi(method, route, cdk, body) {
  if (!cdk) throw new Error("Enter a CDK before calling the Open API.");

  const headers = {
    Accept: "application/json",
    "X-Pixel-CDK": cdk,
  };
  const options = { method, headers };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(`${PIXEL_API_BASE_URL}${route}`, options);
  } catch (error) {
    const next = new Error(`${error.message || "Network request failed."} ${CORS_HELP}`);
    next.cause = error;
    throw next;
  }

  const text = await response.text();
  const data = parseResponse(text);
  if (!response.ok) {
    const error = new Error(data?.message || `Request failed with HTTP ${response.status}.`);
    error.response = data;
    error.status = response.status;
    throw error;
  }

  return data;
}

function parseResponse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function getCdk() {
  const cdk = els.cdkInput.value.trim();
  if (cdk) return cdk;
  return "";
}

function getTaskId() {
  const value = els.taskIdInput.value.trim();
  if (!/^[1-9]\d*$/.test(value)) throw new Error("Enter a valid task ID.");
  return value;
}

function upsertTask(task) {
  if (!task?.id) return;
  state.tasks.set(String(task.id), task);
}

function renderTasks() {
  const tasks = [...state.tasks.values()].sort((a, b) => Number(b.id) - Number(a.id));

  if (!tasks.length) {
    els.taskList.innerHTML = '<div class="empty-state">No tracked tasks yet.</div>';
    return;
  }

  els.taskList.innerHTML = "";
  for (const task of tasks) {
    const item = document.createElement("article");
    item.className = "task-item";
    item.innerHTML = `
      <div class="task-main">
        <div class="task-title">
          <strong>#${escapeHtml(String(task.id))}</strong>
          <span class="badge ${escapeHtml(String(task.status || "created"))}">${escapeHtml(String(task.status || "created"))}</span>
        </div>
        <div class="task-meta">${escapeHtml(task.email || task.type || "Task")} ${task.progress !== undefined ? `- ${escapeHtml(String(task.progress))}%` : ""}</div>
      </div>
      <div class="task-actions">
        <button class="secondary-btn" type="button" title="Query" data-action="query" data-task-id="${escapeHtml(String(task.id))}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 18a8 8 0 1 1 5.7-2.3L21 21"></path></svg>
        </button>
        <button class="danger-btn" type="button" title="Cancel" data-action="cancel" data-task-id="${escapeHtml(String(task.id))}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"></path></svg>
        </button>
        <button class="secondary-btn" type="button" title="Retry" data-action="retry" data-task-id="${escapeHtml(String(task.id))}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4v6h6M20 20v-6h-6M6 17a7 7 0 0 0 11 1M18 7A7 7 0 0 0 7 6"></path></svg>
        </button>
      </div>
    `;

    item.querySelector('[data-action="query"]').addEventListener("click", (event) => {
      withBusy(event.currentTarget, () => queryTask(String(task.id)));
    });
    item.querySelector('[data-action="cancel"]').addEventListener("click", (event) => {
      withBusy(event.currentTarget, () => cancelTask(String(task.id)));
    });
    item.querySelector('[data-action="retry"]').addEventListener("click", (event) => {
      withBusy(event.currentTarget, () => retryTask(String(task.id)));
    });

    els.taskList.append(item);
  }
}

function setResponse(data) {
  state.latestResponse = data;
  els.responseOutput.textContent = JSON.stringify(data, null, 2);
}

async function withBusy(button, action) {
  try {
    button.disabled = true;
    await action();
  } catch (error) {
    const formatted = formatError(error);
    setResponse(formatted);
    toast(formatted.message || "Request failed.", "error");
  } finally {
    button.disabled = false;
  }
}

async function copyResponse() {
  await navigator.clipboard.writeText(JSON.stringify(state.latestResponse, null, 2));
  toast("Response copied.");
}

function formatError(error) {
  return {
    code: error.response?.code || "CLIENT_ERROR",
    message: error.message,
    status: error.status,
    response: error.response,
  };
}

function toast(message, type = "info") {
  const existing = document.querySelector(".toast");
  existing?.remove();

  const element = document.createElement("div");
  element.className = `toast ${type}`;
  element.textContent = message;
  document.body.append(element);
  window.setTimeout(() => element.remove(), 3200);
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return entities[char];
  });
}
