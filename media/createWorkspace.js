const vscode = acquireVsCodeApi();
let projects = [];
let filterText = "";
let scanning = false;
const selectedSet = new Set();

const nameInput = document.getElementById("nameInput");
const filterInput = document.getElementById("filterInput");
const projectListEl = document.getElementById("projectList");
const selectedListEl = document.getElementById("selectedList");
const countLabel = document.getElementById("countLabel");
const subtitle = document.getElementById("subtitle");
const pageTitle = document.getElementById("pageTitle");
const currentBanner = document.getElementById("currentBanner");
const currentBannerName = document.getElementById("currentBannerName");
const currentTag = document.getElementById("currentTag");
const saveBtn = document.getElementById("saveBtn");
const saveOpenBtn = document.getElementById("saveOpenBtn");
const refreshProjectsBtn = document.getElementById("refreshProjectsBtn");

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

function setScanning(nextScanning) {
  scanning = nextScanning;
  refreshProjectsBtn.disabled = scanning;
  refreshProjectsBtn.textContent = scanning ? "加载中…" : "刷新";
}

function loadingHtml() {
  return (
    '<div class="loading">' +
    '<div class="loading-spinner" aria-hidden="true"></div>' +
    '<div class="loading-text">正在加载项目列表</div>' +
    "</div>"
  );
}

function formatScanTime(timestamp) {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleString();
}

function applyMode(mode) {
  const isEdit = mode === "edit";
  pageTitle.textContent = isEdit ? "编辑 Workspace" : "新建 Workspace";
  saveBtn.textContent = isEdit ? "仅保存" : "仅创建";
  saveOpenBtn.textContent = isEdit ? "保存并打开" : "创建并打开";
}

function applyCurrentWorkspace(message) {
  const hasCurrent = !!message.hasCurrentWorkspace && !!message.currentWorkspaceName;
  const editingCurrent = !!message.editingCurrent;
  currentTag.hidden = !editingCurrent;
  if (hasCurrent && !editingCurrent) {
    currentBanner.hidden = false;
    currentBannerName.textContent = message.currentWorkspaceName;
  } else {
    currentBanner.hidden = true;
  }
}

function visibleProjects() {
  const keyword = filterText.trim().toLowerCase();
  return projects.filter((project) => {
    if (!keyword) return true;
    return (
      project.name.toLowerCase().includes(keyword) ||
      project.path.toLowerCase().includes(keyword) ||
      project.parentFolder.toLowerCase().includes(keyword)
    );
  });
}

function updateCount() {
  countLabel.textContent = String(selectedSet.size);
}

function selectedProjects() {
  return projects.filter((project) => selectedSet.has(project.path));
}

function projectItemHtml(project, mode) {
  const manualMark = project.manual ? " · 手动" : "";
  const name = escapeHtml(project.name) + manualMark;
  const pathHtml = escapeHtml(project.path);
  const pathAttr = escapeAttr(project.path);
  if (mode === "select") {
    const checked = selectedSet.has(project.path) ? "checked" : "";
    const checkedClass = selectedSet.has(project.path) ? " is-checked" : "";
    return (
      '<div class="project-item' +
      checkedClass +
      '" title="' +
      pathAttr +
      '">' +
      '<input type="checkbox" data-path="' +
      pathAttr +
      '" ' +
      checked +
      " />" +
      "<label>" +
      '<span class="project-name">' +
      name +
      "</span>" +
      '<span class="project-path">' +
      pathHtml +
      "</span>" +
      "</label>" +
      "</div>"
    );
  }
  return (
    '<div class="project-item selected-item" data-path="' +
    pathAttr +
    '" title="' +
    pathAttr +
    '">' +
    "<label>" +
    '<span class="project-name">' +
    name +
    "</span>" +
    '<span class="project-path">' +
    pathHtml +
    "</span>" +
    "</label>" +
    '<button type="button" class="remove-btn" data-path="' +
    pathAttr +
    '">移除</button>' +
    "</div>"
  );
}

function renderGroups(list, mode) {
  const groups = [];
  const groupMap = new Map();
  for (const project of list) {
    let group = groupMap.get(project.parentFolder);
    if (!group) {
      group = { parentFolder: project.parentFolder, projects: [] };
      groupMap.set(project.parentFolder, group);
      groups.push(group);
    }
    group.projects.push(project);
  }
  return groups
    .map((group) => {
      const items = group.projects
        .map((project) => projectItemHtml(project, mode))
        .join("");
      return (
        '<div class="group"><div class="group-title">' +
        escapeHtml(group.parentFolder) +
        "</div>" +
        items +
        "</div>"
      );
    })
    .join("");
}

function renderAvailable() {
  const leftScroll = projectListEl.scrollTop;
  const visible = visibleProjects();

  if (scanning && !projects.length) {
    projectListEl.innerHTML = loadingHtml();
  } else if (!projects.length) {
    projectListEl.innerHTML =
      '<div class="empty">未找到可勾选的项目。可点击「选择文件夹」添加。</div>';
  } else if (!visible.length) {
    projectListEl.innerHTML = '<div class="empty">没有匹配的项目</div>';
  } else {
    projectListEl.innerHTML = renderGroups(visible, "select");
    if (scanning) {
      projectListEl.insertAdjacentHTML(
        "beforeend",
        '<div class="loading-overlay">' + loadingHtml() + "</div>"
      );
    }
  }

  projectListEl.scrollTop = leftScroll;
}

function renderSelected() {
  const rightScroll = selectedListEl.scrollTop;
  const selected = selectedProjects();
  if (!selected.length) {
    selectedListEl.innerHTML = '<div class="empty">尚未选择项目</div>';
  } else {
    selectedListEl.innerHTML = renderGroups(selected, "selected");
  }
  selectedListEl.scrollTop = rightScroll;
  updateCount();
}

function render() {
  renderAvailable();
  renderSelected();
}

function applyState(message) {
  applyCurrentWorkspace(message);
  setScanning(!!message.scanning);
  applyMode(message.mode || "create");
  if (message.scanning && !message.projects) {
    if (message.initForm) {
      nameInput.value = message.workspaceName || "";
    }
    renderSelected();
    if (!projects.length) renderAvailable();
    return;
  }
  const scanned = message.projects || [];
  if (message.initForm) {
    projects = scanned;
    nameInput.value = message.workspaceName || "";
    selectedSet.clear();
    for (const projectPath of message.selectedPaths || []) {
      selectedSet.add(projectPath);
    }
  } else {
    const scannedPaths = new Set(scanned.map((item) => item.path));
    const extras = projects.filter(
      (item) => item.manual && !scannedPaths.has(item.path)
    );
    projects = extras.concat(scanned);
  }
  const scanTime = formatScanTime(message.scannedAt);
  if (message.scanning) {
    subtitle.textContent = "正在加载项目列表…";
  } else if (message.fromCache) {
    subtitle.textContent =
      "来自缓存" + (scanTime ? "（" + scanTime + "）" : "") + "，可点刷新。";
  } else {
    subtitle.textContent =
      "列表已更新" + (scanTime ? "（" + scanTime + "）" : "");
  }
  renderSelected();
  renderAvailable();
}

function submit(openAfter) {
  const name = nameInput.value.trim();
  if (!name) {
    nameInput.focus();
    return;
  }
  vscode.postMessage({
    type: "save",
    name,
    projectPaths: Array.from(selectedSet),
    openAfter,
  });
}

projectListEl.addEventListener("change", (event) => {
  const target = event.target;
  if (!target || target.type !== "checkbox") return;
  const projectPath = target.getAttribute("data-path");
  if (!projectPath) return;
  if (target.checked) selectedSet.add(projectPath);
  else selectedSet.delete(projectPath);
  render();
});

projectListEl.addEventListener("click", (event) => {
  const target = event.target;
  if (target.tagName === "INPUT") return;
  const item = target.closest(".project-item");
  if (!item) return;
  const checkbox = item.querySelector('input[type="checkbox"]');
  if (!checkbox) return;
  checkbox.checked = !checkbox.checked;
  checkbox.dispatchEvent(new Event("change", { bubbles: true }));
});

selectedListEl.addEventListener("click", (event) => {
  const target = event.target;
  const button = target.closest(".remove-btn");
  const item = target.closest(".selected-item");
  const projectPath =
    (button || item) && (button || item).getAttribute("data-path");
  if (!projectPath) return;
  selectedSet.delete(projectPath);
  render();
});

document.getElementById("editCurrentBtn").addEventListener("click", () => {
  vscode.postMessage({ type: "editCurrent" });
});

document.getElementById("pickFoldersBtn").addEventListener("click", () => {
  vscode.postMessage({ type: "pickFolders" });
});
refreshProjectsBtn.addEventListener("click", () => {
  if (scanning) return;
  vscode.postMessage({ type: "refreshProjects" });
});
document.getElementById("saveBtn").addEventListener("click", () => submit(false));
document.getElementById("saveOpenBtn").addEventListener("click", () => submit(true));
nameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") submit(true);
});
filterInput.addEventListener("input", () => {
  filterText = filterInput.value;
  render();
});

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message.type === "scanning") {
    setScanning(true);
    subtitle.textContent = "正在加载项目列表…";
    if (!projects.length) {
      renderAvailable();
    } else if (!projectListEl.querySelector(".loading-overlay")) {
      projectListEl.insertAdjacentHTML(
        "beforeend",
        '<div class="loading-overlay">' + loadingHtml() + "</div>"
      );
    }
    return;
  }
  if (message.type === "addProjects") {
    const incoming = message.projects || [];
    for (const project of incoming) {
      const existing = projects.find((item) => item.path === project.path);
      if (existing) {
        if (project.manual) existing.manual = true;
      } else {
        projects.push(project);
      }
      selectedSet.add(project.path);
    }
    render();
    return;
  }
  if (message.type === "state") {
    applyState(message);
  }
});

const bootstrapEl = document.getElementById("bootstrap");
if (bootstrapEl && bootstrapEl.textContent) {
  applyState(JSON.parse(bootstrapEl.textContent));
}
vscode.postMessage({ type: "ready" });
