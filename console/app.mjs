const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const names = [
  "Connect",
  "Labs & keys",
  "Seats",
  "Stages & tests",
  "Boundaries",
  "Meta-goal",
  "Cadence",
  "Approval",
  "Budget",
  "Review & rehearse",
];
const inputs = [
  "repository",
  "defaultBranch",
  "implementModel",
  "implementProvider",
  "reviewModel",
  "reviewProvider",
  "rankModel",
  "rankProvider",
  "testCommands",
  "setupCommands",
  "allowedPaths",
  "createOnlyPaths",
  "frozenPaths",
  "goal",
  "constraints",
  "hints",
  "maxAttempts",
  "maxFanout",
  "maxGenerationTokens",
  "deploymentUrl",
];
let step = 0,
  session = {},
  catalog = { labs: [], protectedPaths: [] },
  repo = null,
  generated = null,
  selectedFile = null,
  revision = 0,
  repoRequest = 0,
  repositories = [],
  listRequest = 0,
  catalogue = { labs: [], counts: { bundled: 0, repository: 0, unseen: 0 }, fetchedAt: null },
  modelsRequest = 0;
const SEATS = ["implement", "review", "rank"];
// One project per repository, kept in this tab the way the single draft was.
const PROJECTS_KEY = "self-optimisation-projects";
const LEGACY_DRAFT_KEY = "self-optimisation-draft";
// What "copy settings from another project" carries: how you like to run the
// loop. Everything else describes one repository (its files, tests, goal and
// deployment), and automatic merge is deliberately absent: each project opts
// in on its own.
const SHARED_FIELDS = [
  "labs",
  "implementModel",
  "implementProvider",
  "reviewModel",
  "reviewProvider",
  "rankModel",
  "rankProvider",
  "cadence",
  "maxAttempts",
  "maxFanout",
  "maxGenerationTokens",
];
let projects = [],
  currentProject = null,
  blankDraft = null;
const lineList = (value) =>
  value
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
const node = (tag, text, className) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (className) n.className = className;
  return n;
};
const status = (message, error = false) => {
  const n = $("#global-status");
  n.textContent = message;
  n.className = error ? "notice error" : "status";
};
function draft() {
  const data = Object.fromEntries(inputs.map((id) => [id, $("#" + id).value]));
  for (const id of [
    "testCommands",
    "setupCommands",
    "allowedPaths",
    "createOnlyPaths",
    "frozenPaths",
  ])
    data[id] = lineList(data[id]);
  for (const id of ["maxAttempts", "maxFanout", "maxGenerationTokens"])
    data[id] = Number(data[id]);
  data.labs = $$("input[name=lab]:checked").map((n) => n.value);
  data.cadence = $("input[name=cadence]:checked").value;
  data.approvalClass = $("input[name=approvalClass]:checked").value;
  if (data.approvalClass !== "autonomous-merge") data.deploymentUrl = "";
  return data;
}
const newId = () =>
  globalThis.crypto?.randomUUID?.() ||
  `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
function project(id = currentProject) {
  return projects.find((p) => p.id === id);
}
const projectLabel = (p) => p.draft.repository || "New project";
const projectStatus = (p) =>
  p.setupStatus || `Draft · step ${(p.step || 0) + 1} of 10`;
function persist() {
  try {
    sessionStorage.setItem(
      PROJECTS_KEY,
      JSON.stringify({ current: currentProject, projects }),
    );
  } catch {
    status("This browser cannot remember your projects. Keep this tab open.");
  }
  renderProjects();
}
function save() {
  const p = project();
  if (p) p.draft = draft();
  persist();
}
function setProjectStatus(text) {
  const p = project();
  if (!p || p.setupStatus === text) return;
  p.setupStatus = text;
  persist();
}
function loadProjects() {
  let stored = null;
  try {
    stored = JSON.parse(sessionStorage.getItem(PROJECTS_KEY) || "null");
    if (!stored) {
      // A draft saved before projects existed becomes the first project.
      const legacy = JSON.parse(
        sessionStorage.getItem(LEGACY_DRAFT_KEY) || "null",
      );
      if (legacy)
        stored = { projects: [{ id: newId(), draft: legacy, step: 0 }] };
      sessionStorage.removeItem(LEGACY_DRAFT_KEY);
    }
  } catch {
    status(
      "Saved projects could not be restored. Start a new configuration.",
      true,
    );
  }
  projects = (Array.isArray(stored?.projects) ? stored.projects : []).filter(
    (p) =>
      p && typeof p.id === "string" && p.draft && typeof p.draft === "object",
  );
  if (!projects.length)
    projects = [{ id: newId(), draft: { ...blankDraft }, step: 0 }];
  currentProject = project(stored?.current) ? stored.current : projects[0].id;
}
function applyDraft(data) {
  const values = { ...blankDraft, ...data };
  for (const id of inputs)
    $("#" + id).value = Array.isArray(values[id])
      ? values[id].join("\n")
      : (values[id] ?? "");
  for (const n of $$("input[name=lab]"))
    n.checked = (values.labs || []).includes(n.value);
  for (const id of ["cadence", "approvalClass"]) {
    for (const n of $$(`input[name=${id}]`)) n.checked = n.value === values[id];
    if (!$(`input[name=${id}]:checked`))
      for (const n of $$(`input[name=${id}]`))
        n.checked = n.value === blankDraft[id];
  }
}
function renderProjects() {
  $("#project-list").replaceChildren(
    ...projects.map((p) => {
      const item = node("li");
      const open = node("button", undefined, "project");
      open.type = "button";
      open.title = projectLabel(p);
      if (p.id === currentProject) open.setAttribute("aria-current", "true");
      open.append(
        node("span", projectLabel(p), "project-name"),
        node("span", projectStatus(p), "project-status"),
      );
      open.addEventListener("click", () =>
        switchProject(p.id).catch((e) => status(e.message, true)),
      );
      item.append(open);
      if (projects.length > 1) {
        const remove = node("button", "×", "project-remove");
        remove.type = "button";
        remove.setAttribute("aria-label", `Remove ${projectLabel(p)} from this list`);
        remove.addEventListener("click", () =>
          removeProject(p.id).catch((e) => status(e.message, true)),
        );
        item.append(remove);
      }
      return item;
    }),
  );
}
function closeNewProject() {
  $("#new-project-form").hidden = true;
  $("#new-project").setAttribute("aria-expanded", "false");
}
async function switchProject(id) {
  if (id === currentProject || !project(id)) return;
  save();
  currentProject = id;
  const p = project();
  clearRepository();
  applyDraft(p.draft);
  closeNewProject();
  $("#runs-view").hidden = true;
  $("#setup-view").hidden = false;
  show(p.step || 0, false);
  changed();
  if (session.connected && repositories.length) {
    $("#repo-search").value = "";
    $("#repo-owner").value = "";
    filterRepositories();
    if (repositories.some((r) => r.name === p.draft.repository)) {
      await connectRepository();
      return;
    }
  }
  await loadModels();
}
async function createProject(sourceId) {
  save();
  const source = project(sourceId);
  const fresh = { ...blankDraft };
  if (source)
    for (const field of SHARED_FIELDS)
      if (source.draft[field] !== undefined)
        fresh[field] = Array.isArray(source.draft[field])
          ? [...source.draft[field]]
          : source.draft[field];
  const created = { id: newId(), draft: fresh, step: 0 };
  projects.push(created);
  await switchProject(created.id);
  status(
    source
      ? `New project started with ${projectLabel(source)}'s labs, models, cadence and budget. Choose its repository, tests, files and goal. Automatic merge starts off.`
      : "New project started. Choose its repository to begin.",
  );
  ($("#repo-picker-field").hidden ? $("#repository") : $("#repo-picker")).focus();
}
async function removeProject(id) {
  const p = project(id);
  if (!p || projects.length < 2) return;
  if (
    !confirm(
      `Remove ${projectLabel(p)} from this list? Its draft is discarded. Nothing on GitHub changes.`,
    )
  )
    return;
  if (id === currentProject)
    await switchProject(projects.find((other) => other.id !== id).id);
  projects = projects.filter((other) => other.id !== id);
  persist();
  status(`Removed ${projectLabel(p)} from this list. Nothing on GitHub changed.`);
}
async function api(path, body) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body
      ? {
          "content-type": "application/json",
          "x-csrf-token": session.csrf || "",
        }
      : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && session.connected) {
      session = { ...session, connected: false, csrf: null };
      clearRepository();
      repositories = [];
      $("#repo-filters").hidden = true;
      $("#repo-picker-field").hidden = true;
      renderConnection();
      status(result.error || "GitHub sign-in expired. Connect again.", true);
    }
    throw new Error(result.error || "Request failed.");
  }
  return result;
}
function action(id, fn) {
  $(id).addEventListener("click", async (event) => {
    const b = event.currentTarget;
    b.disabled = true;
    status("");
    try {
      await fn();
    } catch (error) {
      status(error.message, true);
    } finally {
      b.disabled = false;
    }
  });
}
function show(index, focus = true) {
  step = Math.max(0, Math.min(9, index));
  $$("[data-step]").forEach(
    (n) => (n.hidden = Number(n.dataset.step) !== step),
  );
  $$("#steps button").forEach((n, i) => {
    if (i === step) n.setAttribute("aria-current", "step");
    else n.removeAttribute("aria-current");
  });
  $("#back").disabled = step === 0;
  $("#next").hidden = step === 9;
  $("#progress").textContent = `Step ${step + 1} of 10`;
  const p = project();
  if (p && p.step !== step) {
    p.step = step;
    persist();
  }
  if (focus) $("#step-content").focus();
}
function changed() {
  revision++;
  generated = null;
  $("#secret-status").replaceChildren();
  $("#generated").hidden = true;
  $("#validation").replaceChildren();
  $("#deployment-field").hidden = $("#auto-merge-notice").hidden =
    $("input[name=approvalClass]:checked").value !== "autonomous-merge";
  if (repo && repo.name !== $("#repository").value) {
    clearRepository();
    $("#repo-state").textContent =
      "Reconnect this repository to load its files.";
    $("#tree").replaceChildren();
  }
  summary();
  save();
}
/** Every catalogue model as one flat list, newest and unseen-first — the order /api/models already sorted them into. */
function catalogueModels() {
  return catalogue.labs.flatMap((lab) =>
    lab.models.map((model) => ({ ...model, provider: lab.name })),
  );
}
function describeCatalogue() {
  const { repository = 0, unseen = 0 } = catalogue.counts || {};
  const when = catalogue.fetchedAt
    ? new Date(catalogue.fetchedAt).toLocaleDateString()
    : null;
  const listed = `${catalogueModels().length} model${catalogueModels().length === 1 ? "" : "s"} listed`;
  if (repository)
    return (
      `${listed} · ${repository} read from ${catalogue.repository}'s own model snapshot` +
      (catalogue.snapshotReadAt
        ? ` just now (${catalogue.snapshotPath})`
        : "") +
      (unseen
        ? ` · ${unseen} of them newer than the list this console shipped with`
        : "")
    );
  return (
    `${listed} from the list this console shipped with${when ? `, refreshed ${when}` : " (never refreshed from the labs themselves)"}. ` +
    (session.connected && repo
      ? catalogue.snapshotReason ||
        "This repository has no model snapshot yet."
      : "Connect a repository to load the live list its own last run wrote, using its keys — this console never holds one.")
  );
}
function renderModels() {
  $("#model-catalogue").replaceChildren(
    ...catalogueModels().map((model) => {
      const option = new Option(
        `${model.provider}${model.unseen ? " · newer than the bundled list" : ""}`,
        model.id,
      );
      return option;
    }),
  );
  $("#catalogue-state").textContent = describeCatalogue();
  for (const seat of SEATS) syncSeatLab(seat, false);
}
/**
 * Keep a seat's lab beside its model ID. A model the catalogue routes by its
 * own name needs no lab and gets none — writing one would put a line in the
 * generated adapter that changes nothing. A model whose name resolves
 * nowhere (or to a different lab) is unusable without it, so it is filled in
 * and the run can call a model this harness has never heard of.
 */
function syncSeatLab(seat, overwrite = true) {
  const input = $("#" + seat + "Model");
  const select = $("#" + seat + "Provider");
  if (!input || !select) return;
  const entry = catalogueModels().find(
    (m) => m.id.toLowerCase() === input.value.trim().toLowerCase(),
  );
  if (!entry) return;
  if (entry.needsLab && (overwrite || !select.value)) select.value = entry.provider;
  else if (!entry.needsLab && overwrite && select.value === entry.provider)
    select.value = "";
}
async function loadModels() {
  const request = ++modelsRequest;
  const query =
    session.connected && repo
      ? "?repository=" + encodeURIComponent(repo.name)
      : "";
  $("#catalogue-state").textContent = "Reading the model list…";
  try {
    const data = await api("/api/models" + query);
    if (request !== modelsRequest) return;
    catalogue = data;
    renderModels();
  } catch (error) {
    if (request !== modelsRequest) return;
    $("#catalogue-state").textContent =
      "The model list could not be read. You can still type a model ID. " +
      error.message;
  }
}
function summary() {
  const data = draft();
  $("#summary-repo").textContent = data.repository || "No repository selected";
  const rows = [
    ["Watched labs", data.labs.length ? data.labs.join(", ") : "None yet"],
    ["Implementer", data.implementModel || "Not set"],
    ["Reviewer", data.reviewModel || "Not set"],
    ["Test commands", String(data.testCommands.length)],
    ["Editable patterns", String(data.allowedPaths.length)],
    ["Check cadence", data.cadence],
    ["First run", "Manual · pull request"],
    [
      "After activation",
      data.approvalClass === "autonomous-merge"
        ? "Automatic merge (opt-in)"
        : "Pull request (default)",
    ],
    ["Token cap", data.maxGenerationTokens.toLocaleString()],
    [
      "Harness",
      session.install?.mode === "shared"
        ? `Shared · ${session.install.label || session.install.ref.slice(0, 7)}`
        : "Copied into the repository",
    ],
  ];
  $("#summary").replaceChildren(
    ...rows.map(([label, value]) => {
      const row = node("div", undefined, "summary-row");
      row.append(node("span", label), node("strong", value));
      return row;
    }),
  );
  const valid = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(data.repository);
  $("#secrets-link").hidden = !valid;
  if (valid)
    $("#secrets-link").href =
      `https://github.com/${data.repository}/settings/secrets/actions`;
}
function validateStep() {
  const data = draft();
  const requirements = {
    0: [
      ["repository", "Enter owner/repository."],
      ["defaultBranch", "Enter the default branch."],
    ],
    2: [
      ["implementModel", "Enter an implementer model ID."],
      ["reviewModel", "Enter a reviewer model ID."],
    ],
    3: [["testCommands", "Add a real test command."]],
    5: [
      ["goal", "Describe the project goal."],
      ["constraints", "Describe its constraints."],
    ],
  };
  for (const [id, message] of requirements[step] || []) {
    if (!data[id]?.length) {
      $("#" + id).focus();
      throw new Error(message);
    }
  }
  if (step === 0 && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(data.repository))
    throw new Error("Repository must be owner/name.");
  if (step === 1 && !data.labs.length)
    throw new Error("Choose at least one lab.");
  // A model the catalogue knows only because a project listed it may carry a
  // name this harness cannot route on its own. Say so here rather than
  // letting the generator reject the whole configuration nine steps later.
  if (step === 2)
    for (const seat of SEATS) {
      const entry = catalogueModels().find(
        (m) => m.id.toLowerCase() === (data[seat + "Model"] || "").trim().toLowerCase(),
      );
      if (entry?.needsLab && !data[seat + "Provider"]) {
        $("#" + seat + "Provider").focus();
        throw new Error(
          `Choose the lab that serves ${entry.id} — its name does not tell the harness who to call.`,
        );
      }
    }
  if (step === 4 && !data.allowedPaths.length && !data.createOnlyPaths.length)
    throw new Error("Choose editable or create-only paths.");
  if (
    step === 7 &&
    data.approvalClass === "autonomous-merge" &&
    !data.deploymentUrl.startsWith("https://")
  )
    throw new Error(
      "Automatic merge requires an HTTPS deployment verification URL.",
    );
  if (
    step === 8 &&
    (!Number.isInteger(data.maxFanout) ||
      data.maxFanout < 1 ||
      data.maxFanout > 9 ||
      !Number.isInteger(data.maxGenerationTokens) ||
      data.maxGenerationTokens < 10000 ||
      data.maxGenerationTokens > 10000000)
  )
    throw new Error("Use fan-out 1–9 and a token budget of 10,000–10,000,000.");
}
function external(text, url) {
  const link = node("a", text, "button");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}
function clearRepository() {
  repoRequest++;
  revision++;
  repo = null;
  generated = null;
  $("#defaultBranch").readOnly = false;
  $("#tree").replaceChildren();
  $("#setup-state").replaceChildren();
  $("#secret-status").replaceChildren();
  $("#generated").hidden = true;
  $("#open-pr").disabled = true;
  for (const id of ["refresh-setup", "rehearse", "activate"]) $("#" + id).hidden = true;
  $("#repo-state").textContent = "Choose a repository to verify its access and load its files.";
}
function filterRepositories() {
  const query = $("#repo-search").value.trim().toLowerCase();
  const owner = $("#repo-owner").value;
  const visible = repositories.filter((r) => (!owner || r.owner === owner) &&
    (r.name + " " + r.description).toLowerCase().includes(query));
  const selected = repo?.name || $("#repository").value;
  $("#repo-picker").replaceChildren(new Option("Select a repository", ""),
    ...visible.map((r) => new Option(`${r.name} · ${r.private ? "Private" : "Public"}`, r.name)));
  if (visible.some((r) => r.name === selected)) $("#repo-picker").value = selected;
  $("#repo-count").textContent = repositories.length
    ? `${visible.length} of ${repositories.length} repositories${visible.length ? "" : " · Try another search or account."}`
    : "No writable repositories available. Use Manage repository access to install the App on selected repositories. Organisation approval may be required.";
}
async function loadRepositories() {
  const request = ++listRequest;
  clearRepository();
  repositories = [];
  $("#repo-picker").replaceChildren(new Option("Loading repositories…", ""));
  $("#repo-picker").disabled = true;
  $("#repo-picker-field").hidden = false;
  try {
    const data = await api("/api/repositories");
    if (request !== listRequest || !session.connected) return;
    repositories = data.repositories.sort((a, b) => a.name.localeCompare(b.name));
    const owner = $("#repo-owner").value;
    $("#repo-owner").replaceChildren(new Option("All accounts", ""),
      ...[...new Set(repositories.map((r) => r.owner))].sort().map((o) => new Option(o, o)));
    if (repositories.some((r) => r.owner === owner)) $("#repo-owner").value = owner;
    $("#repo-filters").hidden = false;
    filterRepositories();
    if ($("#repo-picker").value) await connectRepository();
  } catch (error) {
    if (request !== listRequest) return;
    $("#repo-picker").replaceChildren(new Option("Could not load repositories", ""));
    $("#repo-count").textContent = "Repository access could not be checked. Refresh to try again.";
    throw error;
  } finally {
    if (request === listRequest) $("#repo-picker").disabled = false;
  }
}
async function connectRepository() {
  const name = $("#repo-picker").value;
  clearRepository();
  const request = repoRequest;
  if (!name) return;
  const current = project();
  if (current && current.draft.repository !== name) current.setupStatus = null;
  $("#repository").value = name;
  changed();
  status("Reading repository and default branch…");
  let data;
  try {
    data = await api("/api/repository?repository=" + encodeURIComponent(name));
  } catch (error) {
    if (request !== repoRequest) return;
    throw error;
  }
  if (request !== repoRequest) return;
  repo = data;
  $("#repository").value = data.name;
  $("#defaultBranch").value = data.defaultBranch;
  $("#defaultBranch").readOnly = true;
  $("#repo-state").textContent =
    `Connected to ${data.name} · ${data.defaultBranch} · ${data.tree.filter((f) => f.type === "blob").length} files${data.existingSetup ? " · Existing installation detected: use the CLI to upgrade." : ""}`;
  renderTree();
  if (data.existingSetup) setProjectStatus("Already installed · upgrade with the CLI");
  changed();
  status("Repository connected.");
  // Its own snapshot is the live model list — read it now rather than making
  // someone find the refresh button to discover the seats screen got better.
  await loadModels();
  await refreshSetup();
}
function renderTree() {
  const rows = repo.tree
    .filter((f) => f.type === "blob")
    .slice(0, 400)
    .map((file) => {
      const row = node("div", undefined, "path-row");
      const select = node("select");
      select.setAttribute("aria-label", `Permission for ${file.path}`);
      for (const [value, label] of [
        ["", "Not editable"],
        ["allowedPaths", "May edit"],
        ["createOnlyPaths", "Create only"],
        ["frozenPaths", "Protected"],
      ])
        select.add(new Option(label, value));
      select.value =
        ["allowedPaths", "createOnlyPaths", "frozenPaths"].find((id) =>
          lineList($("#" + id).value).includes(file.path),
        ) || "";
      select.addEventListener("change", () => {
        for (const id of ["allowedPaths", "createOnlyPaths", "frozenPaths"]) {
          const paths = lineList($("#" + id).value).filter(
            (p) => p !== file.path,
          );
          if (select.value === id) paths.push(file.path);
          $("#" + id).value = paths.join("\n");
        }
        changed();
      });
      row.append(node("code", file.path), select);
      return row;
    });
  $("#tree").replaceChildren(...rows);
  if (repo.tree.length > 400)
    $("#tree").append(
      node(
        "p",
        "Showing the first 400 files. Use patterns below for the rest.",
        "caption",
      ),
    );
}
async function generate() {
  const requestedRevision = revision;
  const result = await api("/api/preview", draft());
  if (requestedRevision !== revision) return;
  generated = result;
  $("#validation").replaceChildren(
    ...result.warnings.map((w) => node("p", w, "notice")),
  );
  $("#file-tabs").replaceChildren(
    ...Object.keys(result.files).map((name) => {
      const b = node("button", name, "button");
      b.type = "button";
      b.addEventListener("click", () => showFile(name));
      return b;
    }),
  );
  showFile(Object.keys(result.files)[0]);
  $("#generated").hidden = false;
  $("#open-pr").disabled = !session.connected || !repo || repo.existingSetup;
  status(
    "Configuration validated. Inspect the generated files before opening a pull request.",
  );
}
function showFile(name) {
  selectedFile = name;
  $("#file-content").textContent = generated.files[name];
  $$("#file-tabs button").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.textContent === name)),
  );
}
async function refreshSetup() {
  if (!session.connected || !repo) return;
  const request = repoRequest;
  const state = await api(
    "/api/setup?repository=" + encodeURIComponent(repo.name),
  );
  if (request !== repoRequest) return;
  $("#setup-state").replaceChildren();
  $("#refresh-setup").hidden = !state.setup;
  $("#rehearse").hidden = true;
  $("#activate").hidden = true;
  if (!state.setup) return;
  $("#setup-state").append(
    node("h3", "Setup pull request"),
    external(`Open pull request #${state.setup.number} ↗`, state.setup.url),
  );
  if (state.changed) {
    setProjectStatus("Setup pull request changed on GitHub");
    $("#setup-state").append(node("p", state.message, "notice warning"));
    return;
  }
  if (!state.merged) {
    setProjectStatus(
      state.state === "closed"
        ? "Setup closed without merging"
        : `Setup PR #${state.setup.number} open`,
    );
    $("#setup-state").append(
      node(
        "p",
        state.state === "closed"
          ? "Setup was closed without merging. No rehearsal can run."
          : "Waiting for you to review and merge the setup pull request.",
        "notice",
      ),
    );
    return;
  }
  if (!state.run) {
    setProjectStatus(
      state.setup.dispatchedAt
        ? "Rehearsal requested"
        : "Setup merged · ready to rehearse",
    );
    $("#setup-state").append(
      node(
        "p",
        state.setup.dispatchedAt
          ? "Rehearsal requested. GitHub may take a moment to show the run. Refresh status shortly."
          : "Setup merged. You can now request a real, focused campaign.",
        "notice",
      ),
    );
    $("#rehearse").hidden = Boolean(state.setup.dispatchedAt);
    return;
  }
  $("#setup-state").append(
    external(
      `Rehearsal: ${state.run.conclusion || state.run.status} ↗`,
      state.run.url,
    ),
  );
  const list = node("ul", undefined, "check-list");
  for (const gate of state.gates)
    list.append(node("li", `${gate.name}: ${gate.result}`));
  $("#setup-state").append(list);
  setProjectStatus(
    state.passed
      ? state.setup.activation
        ? `Activation PR #${state.setup.activation.number} open`
        : "Rehearsal passed"
      : state.run.status === "completed"
        ? "Rehearsal needs attention"
        : "Rehearsal running",
  );
  if (state.passed) {
    $("#setup-state").append(
      node(
        "p",
        "Rehearsal gates passed. Review the generated change on GitHub before enabling recurring runs.",
        "notice success",
      ),
    );
    $("#activate").hidden =
      Boolean(state.setup.activation) ||
      (state.setup.requestedCadence === "manual" &&
        state.setup.requestedApproval === "human-approval-required");
  } else if (state.run.status === "completed")
    $("#setup-state").append(
      node(
        "p",
        "The rehearsal did not pass every required gate. Inspect the run and repair the issue before activation.",
        "notice warning",
      ),
    );
  if (state.setup.activation)
    $("#setup-state").append(
      external("Review activation pull request ↗", state.setup.activation.url),
    );
}
async function showRuns() {
  $("#setup-view").hidden = true;
  $("#runs-view").hidden = false;
  $("#runs-content").replaceChildren();
  if (!session.connected || !repo) {
    $("#runs-content").append(
      node("p", "Connect a repository to see its real workflow runs.", "empty"),
    );
    return;
  }
  const data = await api(
    "/api/runs?repository=" + encodeURIComponent(repo.name),
  );
  if (!data.runs.length) {
    $("#runs-content").append(
      node(
        "p",
        "No self-improvement workflow runs found in this repository.",
        "empty",
      ),
    );
    return;
  }
  for (const run of data.runs) {
    const row = node("div", undefined, "choice-card");
    row.append(
      external(run.name || `Run ${run.id}`, run.url),
      node(
        "span",
        `${run.conclusion || run.status} · ${new Date(run.createdAt).toLocaleString()}`,
      ),
    );
    $("#runs-content").append(row);
  }
}
// A tar archive is supported by Windows, macOS and Linux; values never become shell code.
function tar(files) {
  const enc = new TextEncoder();
  const chunks = [];
  let total = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = enc.encode(content),
      header = new Uint8Array(512);
    const put = (offset, text) => header.set(enc.encode(text), offset);
    put(0, name);
    put(100, "0000644\0");
    put(108, "0000000\0");
    put(116, "0000000\0");
    put(124, data.length.toString(8).padStart(11, "0") + "\0");
    put(136, "00000000000\0");
    put(148, "        ");
    put(156, "0");
    put(257, "ustar\0");
    put(263, "00");
    put(
      148,
      header
        .reduce((a, b) => a + b, 0)
        .toString(8)
        .padStart(6, "0") + "\0 ",
    );
    chunks.push(
      header,
      data,
      new Uint8Array((512 - (data.length % 512)) % 512),
    );
    total += 512 + Math.ceil(data.length / 512) * 512;
  }
  chunks.push(new Uint8Array(1024));
  return new Blob(chunks, { type: "application/x-tar" });
}
action("#back", () => show(step - 1));
action("#next", () => {
  validateStep();
  show(step + 1);
});
action("#generate", generate);
action("#refresh-models", loadModels);
for (const seat of SEATS)
  $("#" + seat + "Model").addEventListener("change", () => syncSeatLab(seat));
action("#refresh-repos", loadRepositories);
$("#repo-search").addEventListener("input", filterRepositories);
$("#repo-owner").addEventListener("change", filterRepositories);
let returningFromGitHub = false;
$("#install-app").addEventListener("click", () => { save(); returningFromGitHub = true; });
$("#sign-in").addEventListener("click", save);
window.addEventListener("focus", () => {
  if (returningFromGitHub && session.connected) {
    returningFromGitHub = false;
    loadRepositories().catch((e) => status(e.message, true));
  }
});
$("#repo-picker").addEventListener("change", () => {
  // A repository that already has a project opens that project, rather than
  // a second draft for the same repository.
  const name = $("#repo-picker").value;
  const existing = projects.find(
    (p) => p.id !== currentProject && name && p.draft.repository === name,
  );
  const next = existing
    ? switchProject(existing.id).then(() =>
        status(`${name} already has a project. Switched to it.`),
      )
    : connectRepository();
  next.catch((e) => status(e.message, true));
});
action("#sign-out", async () => {
  await api("/auth/logout", {});
  sessionStorage.removeItem(PROJECTS_KEY);
  sessionStorage.removeItem(LEGACY_DRAFT_KEY);
  location.reload();
});
action("#check-secrets", async () => {
  if (!session.connected || !repo)
    throw new Error(
      "Connect a repository first. Keys for pinned seats are included once you choose those models.",
    );
  const data = await api("/api/secrets", draft());
  $("#secret-status").replaceChildren(
    ...data.secrets.map((s) =>
      node("li", `${s.present ? "Present" : "Missing"}: ${s.name}`),
    ),
  );
});
action("#open-pr", async () => {
  if (!generated || !repo)
    throw new Error("Generate files for a connected repository first.");
  const result = await api("/api/setup", draft());
  status(`Setup pull request #${result.setup.number} created.`);
  await refreshSetup();
});
action("#refresh-setup", refreshSetup);
action("#rehearse", async () => {
  await api("/api/rehearse", { repository: repo.name });
  await refreshSetup();
});
action("#activate", async () => {
  await api("/api/activate", { repository: repo.name });
  await refreshSetup();
});
action("#download", async () => {
  if (!generated) throw new Error("Generate the files first.");
  const bundle = await api("/api/bundle", draft());
  const url = URL.createObjectURL(tar(bundle.files));
  const a = node("a");
  a.href = url;
  a.download = "self-optimisation-setup.tar";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  status(
    "Setup bundle downloaded. Extract it into a clean branch, inspect the files and follow SELF-IMPROVE-README.md.",
  );
});
action("#reset-button", () => {
  if (!confirm("Reset this project's draft? Nothing on GitHub changes."))
    return;
  const p = project();
  Object.assign(p, { draft: { ...blankDraft }, step: 0, setupStatus: null });
  persist();
  location.reload();
});
$("#new-project").addEventListener("click", () => {
  if (!$("#new-project-form").hidden) return closeNewProject();
  $("#new-project-form").hidden = false;
  $("#new-project").setAttribute("aria-expanded", "true");
  const source = $("#new-project-source");
  source.replaceChildren(
    new Option("Blank project", ""),
    ...projects.map((p) => new Option(`Copy settings from ${projectLabel(p)}`, p.id)),
  );
  source.value = project()?.draft.labs?.length ? currentProject : "";
  source.focus();
});
action("#create-project", () => createProject($("#new-project-source").value));
$("#cancel-project").addEventListener("click", closeNewProject);
action("#runs-button", showRuns);
action("#refresh-runs", showRuns);
action("#back-setup", () => {
  $("#runs-view").hidden = true;
  $("#setup-view").hidden = false;
});
$("#setup-form").addEventListener("submit", (e) => e.preventDefault());
$("#setup-form").addEventListener("input", (event) => {
  if (event.target.id === "repository") {
    clearRepository();
    const p = project();
    if (p) p.setupStatus = null;
  }
  changed();
});
$("#setup-form").addEventListener("change", changed);
function renderConnection() {
  $("#connection").textContent = session.connected
    ? `Signed in as ${session.login}. Choose an installed repository.`
    : session.configured
      ? "Sign in to load repositories and open a setup pull request."
      : "GitHub sign-in has not been configured on this deployment yet. You can complete all ten steps and download the setup bundle.";
  $("#sign-in").hidden = !session.configured || session.connected;
  $("#sign-out").hidden = !session.connected;
  $("#refresh-repos").hidden = !session.connected;
  $("#install-app").hidden = !session.installUrl;
  if (session.installUrl) $("#install-app").href = session.installUrl;
}
async function init() {
  const results = await Promise.all([api("/api/session"), api("/api/catalog")]);
  [session, catalog] = results;
  $("#labs").replaceChildren(
    ...catalog.labs.map((lab) => {
      const label = node("label", undefined, "choice-card");
      const input = node("input");
      input.type = "checkbox";
      input.name = "lab";
      input.value = lab.name;
      const text = node("span");
      text.append(node("b", lab.name), node("small", lab.envKey));
      label.append(input, text);
      return label;
    }),
  );
  for (const seat of SEATS)
    $("#" + seat + "Provider").replaceChildren(
      new Option("From the model ID", ""),
      ...catalog.labs.map((lab) => new Option(lab.name, lab.name)),
    );
  $("#protected-list").replaceChildren(
    ...catalog.protectedPaths.map((p) => node("li", p)),
  );
  names.forEach((name, index) => {
    const li = node("li");
    const b = node("button");
    b.type = "button";
    b.append(
      node("span", String(index + 1).padStart(2, "0"), "number"),
      node("span", name),
    );
    b.addEventListener("click", () => show(index));
    li.append(b);
    $("#steps").append(li);
  });
  // The form's own defaults, read before any saved draft is applied: a new
  // project starts from these, and a reset returns to them.
  blankDraft = draft();
  loadProjects();
  applyDraft(project().draft);
  renderProjects();
  show(project().step || 0, false);
  await loadModels();
  summary();
  $("#deployment-field").hidden = $("#auto-merge-notice").hidden =
    $("input[name=approvalClass]:checked").value !== "autonomous-merge";
  renderConnection();
  const githubResult = new URLSearchParams(location.search).get("github");
  if (githubResult === "cancelled") status("GitHub connection was cancelled. Connect again when you’re ready.");
  if (githubResult) history.replaceState(null, "", "/console");
  if (session.connected) await loadRepositories();
}
init().catch((error) =>
  status("Could not load the console. " + error.message, true),
);

