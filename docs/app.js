const STORAGE_KEY = "fitday_state_v1";
const AI_KEY_STORAGE = "fitday_ai_key_v1";
const AI_BASE_URL_STORAGE = "fitday_ai_base_url_v1";
const AI_THINKING_STORAGE = "fitday_ai_thinking_mode_v1";
const LOCAL_DB_NAME = "fitday_local_db";
const LOCAL_DB_VERSION = 1;
const LOCAL_DB_STORE = "state";
const DAY_MS = 24 * 60 * 60 * 1000;

const EXERCISES = [
  { id: "strength_chest", name: "练胸", met: 5.0, category: "strength" },
  { id: "strength_back", name: "练背", met: 5.0, category: "strength" },
  { id: "strength_shoulders", name: "练肩", met: 4.5, category: "strength" },
  { id: "strength_legs", name: "练腿", met: 5.5, category: "strength" },
  { id: "walking", name: "快走 / 徒步", met: 4.3 },
  { id: "running", name: "跑步", met: 8.3 },
  { id: "commute_cycling", name: "共享单车 / 通勤骑行", met: 5.0 },
  { id: "cycling", name: "骑行 / 公路车", met: 7.5 },
  { id: "swimming", name: "游泳", met: 7.0 },
  { id: "other", name: "其他运动", met: 5.0 },
];

const INTENSITY_GUIDES = {
  "0.75": {
    label: "RPE 2-3",
    cardio: "呼吸平稳，可以轻松聊天，适合热身、恢复或慢速骑行。",
    strength: "大约还能再做 6 次以上，接近热身后的小重量训练。",
  },
  "0.9": {
    label: "RPE 4-5",
    cardio: "能完整说句子，呼吸略快，可轻松持续 30 分钟以上。",
    strength: "大约还能再做 4-5 次，动作轻松但已经有训练感。",
  },
  "1": {
    label: "RPE 6",
    cardio: "呼吸明显加快，但还能说短句，可较长时间坚持。",
    strength: "大约还能再做 3-4 次，属于中等训练强度。",
  },
  "1.15": {
    label: "RPE 7-8",
    cardio: "只能说几个词，出汗明显，适合较硬的间歇或爬坡。",
    strength: "大约还能再做 1-3 次，接近力竭但动作仍稳定。",
  },
  "1.3": {
    label: "RPE 9-10",
    cardio: "几乎无法说话，只能维持短时间，适合冲刺或极限间歇。",
    strength: "最多还能再做 0-1 次，只适合少量高强度组。",
  },
};

const STRENGTH_MOVEMENTS = {
  strength_chest: [
    "杠铃卧推",
    "哑铃卧推",
    "上斜哑铃卧推",
    "器械上斜卧推",
    "器械推胸",
    "器械夹胸",
    "蝴蝶机夹胸",
    "绳索夹胸",
    "俯卧撑",
    "其他练胸动作",
  ],
  strength_back: [
    "引体向上",
    "高位下拉",
    "杠铃划船",
    "哑铃单臂划船",
    "坐姿划船",
    "直臂下压",
    "山羊挺身",
    "其他练背动作",
  ],
  strength_shoulders: [
    "哑铃肩推",
    "杠铃肩推",
    "哑铃侧平举",
    "哑铃前平举",
    "Y举",
    "反向飞鸟",
    "器械飞鸟",
    "面拉",
    "其他练肩动作",
  ],
  strength_legs: [
    "杠铃深蹲",
    "腿举",
    "倒蹬",
    "保加利亚分腿蹲",
    "罗马尼亚硬拉",
    "腿弯举",
    "腿屈伸",
    "臀推",
    "提踵",
    "其他练腿动作",
  ],
};

const DEFAULT_STATE = {
  version: 1,
  updatedAt: "",
  setupComplete: false,
  profile: {
    sex: "male",
    age: 30,
    height: 173,
    startWeight: 75,
    goalRate: 0.4,
    activityFactor: 1.35,
    proteinPerKg: 1.8,
    fatPerKg: 0.75,
  },
  settings: {
    model: "gpt-4.1-mini",
    baseUrl: "",
    lastExerciseType: "",
  },
  ui: {
    lastWeightPromptDate: "",
  },
  weights: [],
  meals: [],
  exercises: [],
  strengthSessions: {},
};

let state = loadState();
let currentPhoto = null;
let currentAnalysis = null;
let photoMode = "meal";
let deferredInstallPrompt = null;
let aiServerConfigured = false;
let toastTimer = null;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadState() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return normalizeState(stored || DEFAULT_STATE);
  } catch {
    return clone(DEFAULT_STATE);
  }
}

function openLocalDatabase() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const request = indexedDB.open(LOCAL_DB_NAME, LOCAL_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(LOCAL_DB_STORE)) {
        database.createObjectStore(LOCAL_DB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
  });
}

async function persistLocalBackup(value) {
  try {
    const database = await openLocalDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(LOCAL_DB_STORE, "readwrite");
      transaction.objectStore(LOCAL_DB_STORE).put(value, "latest");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB write failed"));
    });
    database.close();
  } catch {
    // localStorage remains the primary store when IndexedDB is unavailable.
  }
}

async function readLocalBackup() {
  try {
    const database = await openLocalDatabase();
    const value = await new Promise((resolve, reject) => {
      const transaction = database.transaction(LOCAL_DB_STORE, "readonly");
      const request = transaction.objectStore(LOCAL_DB_STORE).get("latest");
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("IndexedDB read failed"));
    });
    database.close();
    return value;
  } catch {
    return null;
  }
}

async function restoreLocalBackupIfNeeded() {
  const backup = await readLocalBackup();
  if (!backup) return;

  const localUpdatedAt = Date.parse(state.updatedAt || "") || 0;
  const backupUpdatedAt = Date.parse(backup.updatedAt || "") || 0;
  const backupIsBetter =
    backupUpdatedAt > localUpdatedAt ||
    (!state.setupComplete && Boolean(backup.setupComplete));
  if (!backupIsBetter) return;

  state = normalizeState(backup);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // IndexedDB can still serve as the fallback on the next launch.
  }
}

function normalizeState(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    ...clone(DEFAULT_STATE),
    ...source,
    profile: { ...DEFAULT_STATE.profile, ...(source.profile || {}) },
    settings: { ...DEFAULT_STATE.settings, ...(source.settings || {}) },
    ui: { ...DEFAULT_STATE.ui, ...(source.ui || {}) },
    weights: Array.isArray(source.weights) ? source.weights : [],
    meals: Array.isArray(source.meals) ? source.meals : [],
    exercises: Array.isArray(source.exercises) ? source.exercises : [],
    strengthSessions:
      source.strengthSessions && typeof source.strengthSessions === "object"
        ? source.strengthSessions
        : {},
  };
}

function saveState() {
  state.updatedAt = new Date().toISOString();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    window.setTimeout(() => showToast("浏览器主存储写入失败，正在使用本地备份。", "error"), 0);
  }
  void persistLocalBackup(clone(state));
}

function uid(prefix) {
  if (globalThis.crypto?.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function dateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateKey(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  return new Date(year, month - 1, day, 12, 0, 0);
}

function addDays(dateOrKey, amount) {
  const date = typeof dateOrKey === "string" ? parseDateKey(dateOrKey) : new Date(dateOrKey);
  date.setDate(date.getDate() + amount);
  return date;
}

function daysAgoKey(amount) {
  return dateKey(addDays(new Date(), -amount));
}

function round(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sumBy(items, getter) {
  return items.reduce((total, item) => total + (Number(getter(item)) || 0), 0);
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function formatNumber(value, digits = 0) {
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(Number(value) || 0);
}

function formatShortDate(key) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(parseDateKey(key));
}

function safeText(value) {
  return String(value ?? "").trim();
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function renderIcons() {
  if (window.lucide?.createIcons) {
    window.lucide.createIcons({ attrs: { "stroke-width": 2 } });
  }
}

function getMealsForDate(key) {
  return state.meals.filter((meal) => meal.date === key);
}

function getWeightForDate(key) {
  return state.weights.find((entry) => entry.date === key) || null;
}

function getExercisesForDate(key) {
  return state.exercises.filter((exercise) => exercise.date === key);
}

function isStrengthExerciseRecord(exercise) {
  const selected = EXERCISES.find((entry) => entry.id === exercise.type);
  return selected?.category === "strength" || String(exercise.type || "").startsWith("strength_");
}

function getStrengthExercisesForDate(key) {
  return getExercisesForDate(key).filter(isStrengthExerciseRecord);
}

function getStrengthSession(key) {
  return state.strengthSessions?.[key] || null;
}

function calculateStrengthSessionKcal(key, minutes) {
  const exercises = getStrengthExercisesForDate(key);
  if (!exercises.length || minutes <= 0) return 0;
  const weight = getWeightStats().currentWeight;
  let activeMinutes = 0;
  let weightedActive = 0;
  let weightedIntensity = 0;

  exercises.forEach((exercise) => {
    const selected = EXERCISES.find((entry) => entry.id === exercise.type) || {
      met: 5,
      name: exercise.name,
    };
    const movementMinutes = Math.max(0, (Number(exercise.reps) || 0) * (Number(exercise.sets) || 0) * 3 / 60);
    activeMinutes += movementMinutes;
    weightedActive += movementMinutes * Number(selected.met || 5) * Number(exercise.intensity || 1);
    weightedIntensity += movementMinutes * Number(exercise.intensity || 1);
  });

  activeMinutes = Math.min(activeMinutes, minutes);
  const averageMetFactor = activeMinutes > 0 ? weightedActive / activeMinutes : 5;
  const averageIntensity = activeMinutes > 0 ? weightedIntensity / activeMinutes : 1;
  const restMinutes = Math.max(0, minutes - activeMinutes);
  const activeKcal = (averageMetFactor * 3.5 * weight) / 200 * activeMinutes;
  const recoveryKcal =
    (1.5 * 3.5 * weight) / 200 * restMinutes * Math.min(1.2, averageIntensity);
  return round(activeKcal + recoveryKcal);
}

function syncStrengthSession(key, minutes = null) {
  const exercises = getStrengthExercisesForDate(key);
  if (!exercises.length) {
    delete state.strengthSessions[key];
    return;
  }

  const existing = getStrengthSession(key);
  const sessionMinutes =
    minutes === null
      ? Number(existing?.minutes || 0)
      : Math.max(0, Number(minutes) || 0);
  if (!sessionMinutes) {
    state.strengthSessions[key] = {
      date: key,
      minutes: 0,
      kcal: 0,
      estimateSource: "pending",
      aiNotes: "",
      updatedAt: new Date().toISOString(),
    };
    return;
  }

  state.strengthSessions[key] = {
    date: key,
    minutes: sessionMinutes,
    kcal: calculateStrengthSessionKcal(key, sessionMinutes),
    estimateSource: "local",
    aiNotes: "",
    updatedAt: new Date().toISOString(),
  };
}

function getDayTotals(key) {
  const meals = getMealsForDate(key);
  return meals.reduce(
    (totals, meal) => ({
      kcal: totals.kcal + Number(meal.kcal || 0),
      protein: totals.protein + Number(meal.protein || 0),
      carbs: totals.carbs + Number(meal.carbs || 0),
      fat: totals.fat + Number(meal.fat || 0),
    }),
    { kcal: 0, protein: 0, carbs: 0, fat: 0 },
  );
}

function getExerciseTotal(key) {
  const exercises = getExercisesForDate(key);
  const nonStrengthKcal = sumBy(
    exercises.filter((exercise) => !isStrengthExerciseRecord(exercise)),
    (exercise) => exercise.kcal,
  );
  const strengthExercises = exercises.filter(isStrengthExerciseRecord);
  if (!strengthExercises.length) return nonStrengthKcal;

  const strengthSession = getStrengthSession(key);
  if (strengthSession?.minutes > 0) {
    return nonStrengthKcal + Number(strengthSession.kcal || 0);
  }
  return nonStrengthKcal + sumBy(strengthExercises, (exercise) => exercise.kcal);
}

function getWeightStats() {
  const logs = [...state.weights]
    .filter((entry) => entry.date && Number.isFinite(Number(entry.weight)))
    .sort((a, b) => a.date.localeCompare(b.date));

  const latest = logs.at(-1) || null;
  const currentWeight = Number(latest?.weight || state.profile.startWeight || 75);
  const recentStart = daysAgoKey(6);
  const priorStart = daysAgoKey(13);
  const priorEnd = daysAgoKey(7);
  const today = dateKey();

  const recent = logs.filter((entry) => entry.date >= recentStart && entry.date <= today);
  const prior = logs.filter((entry) => entry.date >= priorStart && entry.date <= priorEnd);
  const recentAverage = average(recent.map((entry) => Number(entry.weight)));
  const priorAverage = average(prior.map((entry) => Number(entry.weight)));
  const average7 = average(recent.map((entry) => Number(entry.weight)));

  let weeklyChange = null;
  if (recentAverage !== null && priorAverage !== null) {
    weeklyChange = recentAverage - priorAverage;
  } else if (logs.length >= 2) {
    const first = logs[0];
    const last = logs.at(-1);
    const elapsedDays = Math.max(
      1,
      Math.round((parseDateKey(last.date) - parseDateKey(first.date)) / DAY_MS),
    );
    weeklyChange = ((Number(last.weight) - Number(first.weight)) / elapsedDays) * 7;
  }

  return {
    logs,
    currentWeight,
    average7,
    weeklyChange,
    latest,
  };
}

function calculateBmr(profile, weight) {
  const base = 10 * weight + 6.25 * Number(profile.height) - 5 * Number(profile.age);
  return profile.sex === "female" ? base - 161 : base + 5;
}

function allocateMacros(targetCalories, weight, profile) {
  let protein = weight * Number(profile.proteinPerKg || 1.8);
  let fat = weight * Number(profile.fatPerKg || 0.75);
  let carbCalories = targetCalories - protein * 4 - fat * 9;

  if (carbCalories < 240) {
    const minimumFat = weight * 0.5;
    const fatReduction = Math.min(fat - minimumFat, (240 - carbCalories) / 9);
    fat -= Math.max(0, fatReduction);
    carbCalories = targetCalories - protein * 4 - fat * 9;
  }

  if (carbCalories < 240) {
    const minimumProtein = weight * 1.6;
    const proteinReduction = Math.min(protein - minimumProtein, (240 - carbCalories) / 4);
    protein -= Math.max(0, proteinReduction);
    carbCalories = targetCalories - protein * 4 - fat * 9;
  }

  return {
    protein: Math.max(0, round(protein)),
    carbs: Math.max(0, round(carbCalories / 4)),
    fat: Math.max(0, round(fat)),
  };
}

function calculatePlan(key = dateKey()) {
  const profile = state.profile;
  const weightStats = getWeightStats();
  const weight = weightStats.currentWeight;
  const bmr = calculateBmr(profile, weight);
  const fallbackMaintenance = bmr * Number(profile.activityFactor || 1.35);
  const completedDays = Array.from({ length: 14 }, (_, index) => daysAgoKey(index + 1));
  const intakeDays = completedDays
    .map((day) => getDayTotals(day).kcal)
    .filter((calories) => calories >= 500);
  const averageIntake = average(intakeDays);
  const historicalExercise =
    average(completedDays.map((day) => getExerciseTotal(day))) || 0;

  let adaptiveMaintenance = null;
  if (
    intakeDays.length >= 7 &&
    averageIntake >= 1000 &&
    averageIntake < 6000 &&
    weightStats.weeklyChange !== null
  ) {
    const estimate =
      averageIntake - (Number(weightStats.weeklyChange) * 7700) / 7;
    if (estimate >= bmr * 0.75 && estimate <= bmr * 2.3) {
      adaptiveMaintenance = estimate;
    }
  }

  const maintenance = adaptiveMaintenance || fallbackMaintenance;
  const baseMaintenance = adaptiveMaintenance
    ? adaptiveMaintenance - historicalExercise
    : fallbackMaintenance;
  const deficit = Number(profile.goalRate || 0.4) * 7700 / 7;
  const todayExercise = getExerciseTotal(key);
  const floor = Math.max(profile.sex === "female" ? 1200 : 1500, bmr * 0.75);
  const targetCalories = Math.max(floor, baseMaintenance + todayExercise - deficit);
  const macros = allocateMacros(targetCalories, weight, profile);
  const consumed = getDayTotals(key);
  const progress = targetCalories > 0 ? consumed.kcal / targetCalories : 0;

  return {
    key,
    weight,
    bmr,
    maintenance,
    adaptiveMaintenance,
    averageIntake,
    historicalExercise,
    todayExercise,
    targetCalories: round(targetCalories),
    macros,
    consumed,
    remaining: {
      kcal: round(targetCalories - consumed.kcal),
      protein: round(macros.protein - consumed.protein),
      carbs: round(macros.carbs - consumed.carbs),
      fat: round(macros.fat - consumed.fat),
    },
    progress,
    weightStats,
    calibrationDays: intakeDays.length,
  };
}

function renderToday() {
  const plan = calculatePlan();
  $("#todayDate").textContent = formatShortDate(dateKey());
  $("#targetKcal").textContent = formatNumber(plan.targetCalories);
  $("#remainingKcal").textContent = formatNumber(plan.remaining.kcal);
  $("#targetNote").textContent =
    plan.calibrationDays >= 7
      ? `维持热量按最近饮食与体重趋势估算，今天已计入 ${formatNumber(plan.todayExercise)} kcal 训练消耗。`
      : `继续记录 ${Math.max(0, 7 - plan.calibrationDays)} 天完整饮食后，将自动改用体重趋势校准。`;
  $("#planSource").textContent = plan.adaptiveMaintenance ? "体重趋势自适应" : "基础估算";

  const progress = clamp(plan.progress, 0, 1.25);
  $("#calorieRing").style.background = `conic-gradient(var(--accent) ${progress * 360}deg, var(--line) ${progress * 360}deg)`;

  setMacro("protein", plan);
  setMacro("carbs", plan);
  setMacro("fat", plan);

  $("#weightTrend").textContent =
    plan.weightStats.weeklyChange === null
      ? "待记录"
      : `${plan.weightStats.weeklyChange > 0 ? "+" : ""}${formatNumber(plan.weightStats.weeklyChange, 2)} kg/周`;
  $("#exerciseCredit").textContent = `+${formatNumber(plan.todayExercise)} kcal`;
  $("#maintenanceEstimate").textContent = `${formatNumber(plan.maintenance)} kcal`;

  renderWeightCheckin(plan.weightStats);
  renderMeals();
  renderExercises();
  renderIcons();
}

function renderWeightCheckin(stats) {
  const todayWeight = getWeightForDate(dateKey());
  const checkin = $("#weightCheckin");
  const badge = $("#todayWeightBadge");
  const action = $("#weightCheckinAction");
  const averageText =
    stats.average7 === null ? "暂无 7 日平均" : `7日平均 ${formatNumber(stats.average7, 1)} kg`;

  if (todayWeight) {
    $("#weightCheckinValue").textContent = `${formatNumber(todayWeight.weight, 1)} kg`;
    $("#weightCheckinMeta").textContent = `今日已记录 · ${averageText}`;
    badge.textContent = "今日已记录";
    badge.classList.add("recorded");
    action.textContent = "修改";
    checkin.classList.add("recorded");
  } else {
    $("#weightCheckinValue").textContent = "今日体重未记录";
    $("#weightCheckinMeta").textContent = averageText;
    badge.textContent = "体重未记录";
    badge.classList.remove("recorded");
    action.textContent = "填写";
    checkin.classList.remove("recorded");
  }
}

function setMacro(name, plan) {
  const remaining = plan.remaining[name];
  const consumed = plan.consumed[name];
  const target = plan.macros[name];
  const safeName = name[0].toUpperCase() + name.slice(1);

  $(`#${name}Remaining`).textContent = formatNumber(remaining);
  $(`#${name}Consumed`).textContent = formatNumber(consumed);
  $(`#${name}Target`).textContent = formatNumber(target);
  $(`#${name}Bar`).style.width = `${clamp(target ? (consumed / target) * 100 : 0, 0, 100)}%`;

  const card = $(`.macro-card.${name}`);
  if (card) card.setAttribute("aria-label", `${safeName}剩余 ${formatNumber(remaining)} 克`);
}

function renderMeals() {
  const meals = [...getMealsForDate(dateKey())].sort((a, b) =>
    String(b.createdAt).localeCompare(String(a.createdAt)),
  );
  const list = $("#mealList");
  const empty = $("#mealEmpty");
  list.replaceChildren();
  empty.hidden = meals.length > 0;

  meals.forEach((meal) => {
    const item = createElement("article", "record-item");
    const thumb = createElement("div", "record-thumb");
    if (meal.image) {
      const image = document.createElement("img");
      image.src = meal.image;
      image.alt = "";
      thumb.append(image);
    } else {
      thumb.append(createIcon("utensils"));
    }

    const copy = createElement("div", "record-copy");
    copy.append(
      createElement("strong", "", meal.name || "饮食记录"),
      createElement(
        "small",
        "",
        `蛋白 ${formatNumber(meal.protein, 1)}g · 碳水 ${formatNumber(meal.carbs, 1)}g · 脂肪 ${formatNumber(meal.fat, 1)}g`,
      ),
    );

    const end = createElement("div", "record-row-end");
    const value = createElement("div", "record-value");
    value.append(
      createElement("strong", "", `${formatNumber(meal.kcal)} kcal`),
      createElement("small", "", meal.source === "photo" ? "照片估算" : "手动记录"),
    );
    const deleteButton = createElement("button", "delete-record");
    deleteButton.type = "button";
    deleteButton.setAttribute("aria-label", `删除 ${meal.name}`);
    deleteButton.dataset.deleteMeal = meal.id;
    deleteButton.append(createIcon("trash-2"));
    end.append(value, deleteButton);

    item.append(thumb, copy, end);
    list.append(item);
  });
}

function renderExercises() {
  const exercises = [...getExercisesForDate(dateKey())].sort((a, b) =>
    String(b.createdAt).localeCompare(String(a.createdAt)),
  );
  const list = $("#exerciseList");
  const empty = $("#exerciseEmpty");
  list.replaceChildren();
  empty.hidden = exercises.length > 0;

  const strengthExercises = exercises.filter(isStrengthExerciseRecord);
  if (strengthExercises.length) {
    list.append(createStrengthSessionCard(strengthExercises));
  }

  exercises.filter((exercise) => !isStrengthExerciseRecord(exercise)).forEach((exercise) => {
    const item = createElement("article", "record-item");
    const thumb = createElement("div", "record-thumb");
    thumb.append(createIcon("dumbbell"));

    const copy = createElement("div", "record-copy");
    copy.append(
      createElement("strong", "", exercise.name),
      createElement(
        "small",
        "",
        `${formatNumber(exercise.duration)} 分钟 · ${exercise.intensityLabel || "RPE 6"}`,
      ),
    );

    const end = createElement("div", "record-row-end");
    const value = createElement("div", "record-value");
    value.append(
      createElement("strong", "", `+${formatNumber(exercise.kcal)}`),
      createElement("small", "", "kcal"),
    );
    const deleteButton = createElement("button", "delete-record");
    deleteButton.type = "button";
    deleteButton.setAttribute("aria-label", `删除 ${exercise.name}`);
    deleteButton.dataset.deleteExercise = exercise.id;
    deleteButton.append(createIcon("trash-2"));
    end.append(value, deleteButton);

    item.append(thumb, copy, end);
    list.append(item);
  });
}

function createStrengthSessionCard(exercises) {
  const session = getStrengthSession(dateKey());
  const card = createElement("article", "strength-session-card");
  const header = createElement("div", "strength-session-header");
  const thumb = createElement("div", "record-thumb");
  thumb.append(createIcon("dumbbell"));
  const headerCopy = createElement("div", "strength-session-header-copy");
  const totalVolume = exercises.reduce(
    (sum, exercise) => sum + (Number(exercise.trainingVolume) || 0),
    0,
  );
  const sessionSummary = session?.minutes
    ? `总容量 ${formatNumber(totalVolume)} kg · ${formatNumber(session.minutes)} 分钟`
    : `总容量 ${formatNumber(totalVolume)} kg · 请填写整场总时长`;
  headerCopy.append(
    createElement("strong", "", `力量训练 · ${exercises.length} 个动作`),
    createElement("small", "", sessionSummary),
  );
  const value = createElement("div", "record-value");
  value.append(
    createElement(
      "strong",
      "",
      session?.minutes ? `${formatNumber(session.kcal)} kcal` : "待填时长",
    ),
    createElement(
      "small",
      "",
      session?.estimateSource === "ai" ? "AI 估算" : session?.minutes ? "本地估算" : "未计算",
    ),
  );
  header.append(thumb, headerCopy, value);
  card.append(header);

  const movementList = createElement("div", "strength-movement-list");
  exercises.forEach((exercise) => {
    const row = createElement("div", "strength-movement-row");
    const copy = createElement("div");
    const load = exercise.weightKg
      ? `${formatNumber(exercise.sets || 1)}组×${formatNumber(exercise.reps || 1)}次×${formatNumber(exercise.weightKg, 1)}kg`
      : `${formatNumber(exercise.sets || 1)}组×${formatNumber(exercise.reps || 1)}次`;
    copy.append(
      createElement("strong", "", `${exercise.name} · ${exercise.strengthMovement || "其他动作"}`),
      createElement("small", "", `${load} · ${exercise.intensityLabel || "RPE 6"}`),
    );
    const deleteButton = createElement("button", "delete-record");
    deleteButton.type = "button";
    deleteButton.setAttribute("aria-label", `删除 ${exercise.strengthMovement || exercise.name}`);
    deleteButton.dataset.deleteExercise = exercise.id;
    deleteButton.append(createIcon("trash-2"));
    row.append(copy, deleteButton);
    movementList.append(row);
  });
  card.append(movementList);

  const editor = createElement("div", "strength-duration-editor");
  const label = document.createElement("label");
  label.append(createElement("span", "", "今日力训时长（分钟）"));
  const input = document.createElement("input");
  input.id = "dailyStrengthMinutes";
  input.type = "number";
  input.min = "1";
  input.max = "600";
  input.step = "1";
  input.inputMode = "numeric";
  input.placeholder = "手动填写";
  input.value = session?.minutes || "";
  label.append(input);
  const saveButton = createElement("button", "icon-text-button");
  saveButton.type = "button";
  saveButton.id = "saveStrengthMinutesButton";
  saveButton.dataset.saveStrengthMinutes = "true";
  saveButton.append(createIcon("check"), document.createTextNode("保存"));
  editor.append(label, saveButton);
  card.append(editor);
  return card;
}

async function saveDailyStrengthMinutes(button) {
  const key = dateKey();
  const minutes = Math.max(0, Number($("#dailyStrengthMinutes")?.value) || 0);
  const exercises = getStrengthExercisesForDate(key);
  if (!exercises.length || minutes <= 0) {
    showToast("请填写有效的力量训练总时长。", "error");
    return;
  }

  const localKcal = calculateStrengthSessionKcal(key, minutes);
  let kcal = localKcal;
  let estimateSource = "local";
  let aiNotes = "";
  const apiKey = localStorage.getItem(AI_KEY_STORAGE) || "";
  const baseUrl = localStorage.getItem(AI_BASE_URL_STORAGE) || state.settings.baseUrl || "";
  const model = localStorage.getItem("fitday_model_v1") || state.settings.model;

  if (apiKey) {
    button.classList.add("loading");
    button.disabled = true;
    try {
      const aiEstimate = await requestStrengthSessionAiEstimate({
        baseUrl,
        apiKey,
        model,
        exercises,
        duration: minutes,
      });
      kcal = Math.round(clamp(aiEstimate.kcal, localKcal * 0.5, localKcal * 3));
      estimateSource = "ai";
      aiNotes = aiEstimate.notes;
    } catch (error) {
      showToast(`AI 精算失败，已使用本地估算：${error.message}`, "error");
    } finally {
      button.classList.remove("loading");
      button.disabled = false;
    }
  }

  state.strengthSessions[key] = {
    date: key,
    minutes,
    kcal,
    estimateSource,
    aiNotes,
    updatedAt: new Date().toISOString(),
  };
  saveState();
  renderAll();
  showToast(estimateSource === "ai" ? "AI 已完成今日力量训练精算。" : "今日力训时长已保存。");
}

function createIcon(name) {
  const icon = document.createElement("i");
  icon.dataset.lucide = name;
  return icon;
}

function renderRecords() {
  const plan = calculatePlan();
  const stats = plan.weightStats;
  $("#maintenanceKcal").textContent = formatNumber(plan.maintenance);
  $("#adaptiveStatus").textContent = plan.adaptiveMaintenance ? "趋势自适应已启用" : `校准中 ${plan.calibrationDays}/7 天`;
  $("#latestWeight").textContent = stats.latest ? `${formatNumber(stats.currentWeight, 1)} kg` : "--";
  $("#averageWeight").textContent =
    stats.average7 === null ? "--" : `${formatNumber(stats.average7, 1)} kg`;
  $("#weeklyChange").textContent =
    stats.weeklyChange === null
      ? "--"
      : `${stats.weeklyChange > 0 ? "+" : ""}${formatNumber(stats.weeklyChange, 2)} kg`;

  renderWeightChart(stats.logs);
  renderDailySummary();
  renderIcons();
}

function renderWeightChart(logs) {
  const container = $("#weightChart");
  container.replaceChildren();

  const recent = logs.slice(-30);
  if (recent.length < 2) {
    container.append(createElement("div", "chart-empty", "至少记录 2 次体重后显示趋势"));
    return;
  }

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 320 160");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "最近体重趋势图");

  const values = recent.map((entry) => Number(entry.weight));
  const minValue = Math.min(...values) - 0.4;
  const maxValue = Math.max(...values) + 0.4;
  const range = Math.max(0.8, maxValue - minValue);
  const points = recent.map((entry, index) => {
    const x = 14 + (index / (recent.length - 1)) * 292;
    const y = 142 - ((Number(entry.weight) - minValue) / range) * 124;
    return { x, y, value: Number(entry.weight), date: entry.date };
  });

  [36, 76, 116].forEach((y) => {
    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", "12");
    line.setAttribute("x2", "308");
    line.setAttribute("y1", String(y));
    line.setAttribute("y2", String(y));
    line.setAttribute("stroke", "#e6e2d9");
    line.setAttribute("stroke-width", "1");
    svg.append(line);
  });

  const path = document.createElementNS(ns, "path");
  path.setAttribute(
    "d",
    points.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" "),
  );
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "#147b72");
  path.setAttribute("stroke-width", "3");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);

  points.forEach((point) => {
    const circle = document.createElementNS(ns, "circle");
    circle.setAttribute("cx", String(point.x));
    circle.setAttribute("cy", String(point.y));
    circle.setAttribute("r", "4");
    circle.setAttribute("fill", "#fffdf8");
    circle.setAttribute("stroke", "#e85d3f");
    circle.setAttribute("stroke-width", "2.5");
    const title = document.createElementNS(ns, "title");
    title.textContent = `${point.date} ${point.value} kg`;
    circle.append(title);
    svg.append(circle);
  });

  container.append(svg);
}

function renderDailySummary() {
  const list = $("#dailySummary");
  list.replaceChildren();

  for (let index = 0; index < 14; index += 1) {
    const key = daysAgoKey(index);
    const totals = getDayTotals(key);
    const exercise = getExerciseTotal(key);
    const weight = state.weights.find((entry) => entry.date === key);
    const row = createElement("article", "daily-row");
    const date = createElement("div", "daily-date");
    date.append(
      createElement("strong", "", index === 0 ? "今天" : formatShortDate(key)),
      createElement("small", "", weight ? `${formatNumber(weight.weight, 1)} kg` : "未记体重"),
    );

    const nutrients = createElement("div", "daily-nutrients");
    appendMetric(nutrients, "蛋白", totals.protein, "g");
    appendMetric(nutrients, "碳水", totals.carbs, "g");
    appendMetric(nutrients, "脂肪", totals.fat, "g");
    if (exercise) appendMetric(nutrients, "训练", exercise, "kcal");

    const kcal = createElement("div", "daily-kcal");
    kcal.append(
      createElement("strong", "", `${formatNumber(totals.kcal)} kcal`),
      createElement("small", "", totals.kcal ? "已记录" : "无记录"),
    );
    row.append(date, nutrients, kcal);
    list.append(row);
  }
}

function appendMetric(container, label, value, unit) {
  const span = createElement("span");
  span.append(`${label} `, createElement("b", "", `${formatNumber(value, 1)}${unit}`));
  container.append(span);
}

function renderSettings() {
  const profile = state.profile;
  $("#settingSex").value = profile.sex;
  $("#settingAge").value = profile.age;
  $("#settingHeight").value = profile.height;
  $("#settingStartWeight").value = profile.startWeight;
  $("#settingGoalRate").value = String(profile.goalRate);
  $("#settingActivityFactor").value = String(profile.activityFactor);
  $("#settingProteinPerKg").value = profile.proteinPerKg;
  $("#settingFatPerKg").value = profile.fatPerKg;
  $("#settingBaseUrl").value =
    localStorage.getItem(AI_BASE_URL_STORAGE) || state.settings.baseUrl || "";
  $("#settingModel").value = localStorage.getItem("fitday_model_v1") || state.settings.model || "gpt-4.1-mini";
  $("#settingApiKey").value = localStorage.getItem(AI_KEY_STORAGE) || "";
  $("#settingThinkingMode").value = localStorage.getItem(AI_THINKING_STORAGE) || "off";
  $("#aiStatus").textContent = aiServerConfigured
    ? "服务端已配置"
    : localStorage.getItem(AI_KEY_STORAGE)
      ? "本机已配置"
      : "未配置";
}

function renderAll() {
  renderToday();
  renderRecords();
  renderSettings();
  renderIcons();
}

function switchView(viewName) {
  const viewMap = {
    today: "todayView",
    records: "recordsView",
    settings: "settingsView",
  };

  Object.entries(viewMap).forEach(([name, id]) => {
    $(`#${id}`).hidden = name !== viewName;
  });
  $$(".nav-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === viewName);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function openDialog(id) {
  const dialog = $(`#${id}`);
  if (dialog && !dialog.open) dialog.showModal();
  renderIcons();
}

function closeDialog(id) {
  const dialog = $(`#${id}`);
  if (dialog?.open) dialog.close();
}

function showToast(message, type = "success") {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.toggle("error", type === "error");
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
}

function upsertWeight(key, value) {
  const index = state.weights.findIndex((entry) => entry.date === key);
  const entry = {
    id: index >= 0 ? state.weights[index].id : uid("weight"),
    date: key,
    weight: round(value, 1),
    createdAt: new Date().toISOString(),
  };
  if (index >= 0) state.weights[index] = entry;
  else state.weights.push(entry);
}

function openWeightDialog(key = dateKey()) {
  const existing = getWeightForDate(key);
  const stats = getWeightStats();
  $("#weightDate").value = key;
  $("#weightDate").max = dateKey();
  $("#weightValue").value =
    existing?.weight || stats.latest?.weight || state.profile.startWeight || "";
  openDialog("weightDialog");
}

function maybePromptDailyWeight() {
  if (!state.setupComplete) return;

  const today = dateKey();
  if (getWeightForDate(today) || state.ui.lastWeightPromptDate === today) return;

  state.ui.lastWeightPromptDate = today;
  saveState();
  window.setTimeout(() => {
    if (!getWeightForDate(today) && !$("#weightDialog").open && !$("#setupDialog").open) {
      openWeightDialog(today);
    }
  }, 350);
}

function populateStrengthMovements(exerciseId) {
  const select = $("#exerciseMovement");
  const movements = STRENGTH_MOVEMENTS[exerciseId] || [];
  const existing = select.value;
  select.replaceChildren();
  movements.forEach((name) => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    select.append(option);
  });
  if (movements.includes(existing)) select.value = existing;
}

function updateStrengthFields() {
  const selected =
    EXERCISES.find((exercise) => exercise.id === $("#exerciseType").value) ||
    EXERCISES[0];
  const isStrength = selected.category === "strength";
  $("#strengthMovementField").hidden = !isStrength;
  $("#strengthWeightField").hidden = !isStrength;
  $("#strengthRepsField").hidden = !isStrength;
  $("#strengthSetsField").hidden = !isStrength;
  $("#strengthVolumeHint").hidden = !isStrength;
  $("#exerciseDurationField").hidden = isStrength;

  if (isStrength) {
    populateStrengthMovements(selected.id);
    updateStrengthVolumeHint();
  }
}

function updateStrengthVolumeHint() {
  const weight = Math.max(0, Number($("#exerciseWeight").value) || 0);
  const reps = Math.max(1, Number($("#exerciseReps").value) || 1);
  const sets = Math.max(1, Number($("#exerciseSets").value) || 1);
  const volume = weight * reps * sets;
  $("#strengthVolumeHint").textContent = weight
    ? `训练容量：${formatNumber(volume)} kg（${sets} 组 × ${reps} 次 × ${formatNumber(weight, 1)} kg）`
    : `训练容量：${sets} 组 × ${reps} 次，自重动作未计入额外负荷`;
}

function calculateExerciseKcal(selected, duration, intensity) {
  const weight = getWeightStats().currentWeight;
  return (selected.met * 3.5 * weight) / 200 * duration * intensity;
}

function updateExerciseEstimate() {
  const selected = EXERCISES.find((exercise) => exercise.id === $("#exerciseType").value) || EXERCISES[0];
  const intensity = Number($("#exerciseIntensity").value || 1);
  updateStrengthFields();
  updateExerciseIntensityHint(selected, intensity);
}

async function requestStrengthSessionAiEstimate({
  baseUrl,
  apiKey,
  model,
  exercises,
  duration,
}) {
  const endpoint = `${String(baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "")}/chat/completions`;
  const bodyWeight = getWeightStats().currentWeight;
  const workout = exercises.map((exercise) => {
    const selected = EXERCISES.find((entry) => entry.id === exercise.type);
    return {
      part: selected?.name || exercise.name,
      movement: exercise.strengthMovement || exercise.name,
      weight_kg: Number(exercise.weightKg) || 0,
      reps: Number(exercise.reps) || 0,
      sets: Number(exercise.sets) || 0,
      volume_kg: Number(exercise.trainingVolume) || 0,
      rpe: exercise.intensityLabel || "RPE 6",
    };
  });
  const prompt = [
    "你是力量训练消耗估算助手。根据整次训练的全部动作估算净运动消耗，只返回 JSON。",
    `体重：${bodyWeight} kg`,
    `本次力量训练总时长：${duration} 分钟`,
    `动作明细：${JSON.stringify(workout)}`,
    "注意：训练容量不等于热量，组间休息只带来较低的恢复消耗。请综合总时长、动作、组数、次数、负荷、RPE 和训练容量估算整次训练消耗。",
    '只返回 JSON：{"kcal":180,"confidence":"中","notes":"简短说明"}',
  ].join("\n");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      ...getProviderRequestOptions(baseUrl),
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      payload?.error?.message ||
        payload?.message ||
        `AI 服务返回错误（HTTP ${response.status}）。`,
    );
  }
  const result = extractJsonObject(payload.choices?.[0]?.message?.content);
  const kcal = Number(result?.kcal);
  if (!Number.isFinite(kcal) || kcal <= 0) {
    throw new Error("AI 没有返回有效的力量训练消耗。");
  }
  return {
    kcal: round(kcal),
    confidence: ["低", "中", "高"].includes(result?.confidence) ? result.confidence : "中",
    notes: safeText(result?.notes),
  };
}

function updateExerciseIntensityHint(selected = null, intensity = null) {
  const exercise =
    selected ||
    EXERCISES.find((entry) => entry.id === $("#exerciseType").value) ||
    EXERCISES[0];
  const intensityValue =
    intensity === null ? Number($("#exerciseIntensity").value || 1) : Number(intensity);
  const guide = INTENSITY_GUIDES[String(intensityValue)] || INTENSITY_GUIDES["1"];
  const isStrength = exercise.category === "strength";
  const description = (isStrength ? guide.strength : guide.cardio).replace(
    /[。；;]+$/,
    "",
  );
  const maxHeartRate = Math.round(208 - 0.7 * Number(state.profile.age || 30));
  const heartRateRanges = {
    "0.75": [0.55, 0.65],
    "0.9": [0.65, 0.75],
    "1": [0.75, 0.82],
    "1.15": [0.82, 0.9],
    "1.3": [0.9, 1],
  };
  const [low, high] = heartRateRanges[String(intensityValue)] || heartRateRanges["1"];
  const heartRateText =
    isStrength
      ? ""
      : `，估算心率约 ${Math.round(maxHeartRate * low)}-${Math.round(maxHeartRate * high)} 次/分`;
  $("#exerciseIntensityHint").textContent = `${guide.label}：${description}${heartRateText}。`;
  renderIntensityReference(exercise, intensityValue);
}

function renderIntensityReference(exercise, intensityValue) {
  const container = $("#intensityReference");
  const isStrength = exercise.category === "strength";
  const age = Number(state.profile.age || 30);
  const maxHeartRate = Math.round(208 - 0.7 * age);
  const rows = [
    {
      value: "0.75",
      label: "RPE 2-3",
      cardio: "可唱歌、正常聊天",
      heartRate: [0.55, 0.65],
      strength: "还能做 6 次以上",
      usage: "热身或技术练习",
    },
    {
      value: "0.9",
      label: "RPE 4-5",
      cardio: "能完整说长句",
      heartRate: [0.65, 0.75],
      strength: "还能做 4-5 次",
      usage: "常规训练组",
    },
    {
      value: "1",
      label: "RPE 6",
      cardio: "只能说短句",
      heartRate: [0.75, 0.82],
      strength: "还能做 3-4 次",
      usage: "中等强度组",
    },
    {
      value: "1.15",
      label: "RPE 7-8",
      cardio: "只能说几个词",
      heartRate: [0.82, 0.9],
      strength: "还能做 1-3 次",
      usage: "接近力竭的强度组",
    },
    {
      value: "1.3",
      label: "RPE 9-10",
      cardio: "几乎不能说话",
      heartRate: [0.9, 1],
      strength: "还能做 0-1 次",
      usage: "极限组，少量使用",
    },
  ];

  container.replaceChildren();
  const header = createElement("div", "intensity-reference-head");
  header.append(
    createElement("strong", "", "RPE"),
    createElement("span", "", isStrength ? "还能再做" : "说话测试"),
    createElement("span", "", isStrength ? "适用场景" : "心率约"),
  );
  container.append(header);

  rows.forEach((row) => {
    const element = createElement(
      "div",
      `intensity-reference-row${String(intensityValue) === row.value ? " selected" : ""}`,
    );
    const metric = isStrength
      ? row.strength
      : `${Math.round(maxHeartRate * row.heartRate[0])}-${Math.round(maxHeartRate * row.heartRate[1])}`;
    element.append(
      createElement("strong", "", row.label),
      createElement("span", "", isStrength ? row.usage : row.cardio),
      createElement("span", "", metric),
    );
    container.append(element);
  });

  container.append(
    createElement(
      "p",
      "intensity-reference-note",
      isStrength
        ? "按做完当前组后，还能标准完成几次来判断。"
        : `按年龄 ${age} 岁估算最大心率约 ${maxHeartRate} 次/分；如有心率设备，以实测为准。`,
    ),
  );
}

function populateExerciseSelect() {
  const select = $("#exerciseType");
  select.replaceChildren();
  EXERCISES.forEach((exercise) => {
    const option = document.createElement("option");
    option.value = exercise.id;
    option.textContent = exercise.name;
    select.append(option);
  });
}

function resizeImage(file, maxSize, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("无法读取图片。"));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("图片格式无法识别。"));
      image.onload = () => {
        const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

function resetPhotoDialog() {
  currentPhoto = null;
  currentAnalysis = null;
  $("#photoInput").value = "";
  $("#photoPreview").hidden = true;
  $("#photoPreview").removeAttribute("src");
  $("#photoPlaceholder").hidden = false;
  $("#photoNote").value = "";
  $("#photoResult").hidden = true;
  $("#analysisItems").replaceChildren();
  setPhotoMode("meal");
}

function setPhotoMode(mode) {
  photoMode = mode === "label" ? "label" : "meal";
  $$("[data-photo-mode]").forEach((button) => {
    const active = button.dataset.photoMode === photoMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });

  const isLabel = photoMode === "label";
  $("#photoDialogTitle").textContent = isLabel ? "识别营养成分表" : "拍照识别";
  $("#photoModeHint").textContent = isLabel
    ? "读取包装上的每 100 克、每 100 毫升或每份营养数据，再按实际食用量换算。"
    : "适合食堂、外卖或已经装盘的混合食物，AI 会估算份量和营养。";
  $("#photoPickerHint").textContent = isLabel
    ? "让营养成分表充满画面，确保数值和单位清晰可读"
    : "尽量俯拍，包含整份食物和参照物";
  $("#photoNote").placeholder = isLabel
    ? "例如：这是牛奶包装背面，准备喝 250 毫升"
    : "例如：米饭只吃一半，鸡胸肉约一掌";
  $("#analyzePhotoButtonLabel").textContent = isLabel ? "读取营养成分表" : "开始估算";
  $("#photoResult").hidden = true;
  $("#labelBasisPanel").hidden = true;
  currentAnalysis = null;
  renderIcons();
}

function extractJsonObject(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function sanitizeDirectFoodAnalysis(raw) {
  const items = (Array.isArray(raw?.items) ? raw.items : []).slice(0, 30).map((item) => ({
    name: safeText(item?.name) || "未命名食物",
    portion: safeText(item?.portion) || "份量未知",
    kcal: Math.max(0, Number(item?.kcal) || 0),
    protein: Math.max(0, Number(item?.protein) || 0),
    carbs: Math.max(0, Number(item?.carbs) || 0),
    fat: Math.max(0, Number(item?.fat) || 0),
  }));
  const totals = items.reduce(
    (sum, item) => ({
      kcal: sum.kcal + item.kcal,
      protein: sum.protein + item.protein,
      carbs: sum.carbs + item.carbs,
      fat: sum.fat + item.fat,
    }),
    { kcal: 0, protein: 0, carbs: 0, fat: 0 },
  );

  return {
    items,
    totals: {
      kcal: round(totals.kcal, 1),
      protein: round(totals.protein, 1),
      carbs: round(totals.carbs, 1),
      fat: round(totals.fat, 1),
    },
    confidence: ["低", "中", "高"].includes(raw?.confidence) ? raw.confidence : "中",
    notes: safeText(raw?.notes) || "请按实际份量修正估算值。",
  };
}

function sanitizeDirectLabelAnalysis(raw) {
  const basisType = raw?.basis_type === "per_serving" ? "per_serving" : "per_100";
  const basisAmount =
    basisType === "per_serving"
      ? 1
      : Math.max(1, Number(raw?.basis_amount) || 100);
  const basisUnit = safeText(raw?.basis_unit) || (basisType === "per_serving" ? "份" : "g");

  return {
    mode: "label",
    items: [],
    name: safeText(raw?.name) || "包装食品",
    basisType,
    basisAmount,
    basisUnit,
    perBasis: {
      kcal: Math.max(0, Number(raw?.kcal) || 0),
      protein: Math.max(0, Number(raw?.protein) || 0),
      carbs: Math.max(0, Number(raw?.carbs) || 0),
      fat: Math.max(0, Number(raw?.fat) || 0),
    },
    defaultAmount: Math.max(
      0,
      Number(raw?.default_amount) || (basisType === "per_serving" ? 1 : basisAmount),
    ),
    confidence: ["低", "中", "高"].includes(raw?.confidence) ? raw.confidence : "中",
    notes: safeText(raw?.notes) || "数值来自营养成分表，请核对包装上的单位和实际食用量。",
  };
}

function getProviderRequestOptions(baseUrl) {
  const options = {
    temperature: 0.1,
    max_tokens: 2000,
    stream: false,
  };
  if (!/siliconflow\.cn/i.test(String(baseUrl || ""))) return options;

  const thinkingMode = localStorage.getItem(AI_THINKING_STORAGE) || "off";
  if (thinkingMode === "off") {
    options.enable_thinking = false;
  } else if (thinkingMode === "low") {
    options.enable_thinking = true;
    options.thinking_budget = 128;
  }
  return options;
}

async function requestFoodAnalysisDirect({ baseUrl, apiKey, model, image, note, mode }) {
  const endpoint = `${String(baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "")}/chat/completions`;
  const isLabel = mode === "label";
  const prompt = (isLabel
    ? [
        "你是包装食品营养成分表读取助手。只读取图片中的营养成分表，不要读取配料列表。",
        "识别产品名称，以及营养成分表声明的基准：每100克、每100毫升或每份。",
        "提取该基准对应的热量 kcal、蛋白质、碳水、脂肪，单位均为克。",
        "不要乘以整包重量，不要自行换算总量；只返回包装上标注的基准数值。",
        "如果能看到单份或整包规格，填写 default_amount，单位沿用 basis_unit。",
        "看不清时降低 confidence，并在 notes 说明。",
        note ? `用户补充说明：${String(note).slice(0, 300)}` : "",
        "只返回 JSON，不要 Markdown。",
        'JSON 格式：{"mode":"label","name":"纯牛奶","basis_type":"per_100","basis_amount":100,"basis_unit":"ml","kcal":65,"protein":3.2,"carbs":4.8,"fat":3.6,"default_amount":250,"confidence":"高","notes":""}',
      ]
    : [
        "你是饮食照片估算助手。识别图片中的食物与饮料，并估算可食用份量。",
        "使用中国家庭常用份量描述，例如半碗、一拳、100克、1杯。",
        "热量单位为 kcal，蛋白质/碳水/脂肪单位为克。只给出数值。",
        "如果无法辨认或份量遮挡严重，降低 confidence，并在 notes 说明原因。",
        "不要把餐具、包装、桌面或背景算成食物。",
        note ? `用户补充说明：${String(note).slice(0, 300)}` : "",
        "只返回 JSON，不要 Markdown。",
        'JSON 格式：{"items":[{"name":"米饭","portion":"1碗","kcal":230,"protein":4,"carbs":50,"fat":0.5}],"confidence":"中","notes":"估算说明"}',
      ])
    .filter(Boolean)
    .join("\n");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      ...getProviderRequestOptions(baseUrl),
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: image } },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      payload?.error?.message ||
        payload?.message ||
        `视觉模型接口返回错误（HTTP ${response.status}）。`,
    );
  }

  const raw = extractJsonObject(payload.choices?.[0]?.message?.content);
  if (!raw) throw new Error("视觉模型返回的内容无法解析，请换一张更清晰的照片。");
  return isLabel ? sanitizeDirectLabelAnalysis(raw) : sanitizeDirectFoodAnalysis(raw);
}

function canUseLocalAnalysisServer() {
  const host = location.hostname;
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host.endsWith(".ts.net") ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)
  );
}

function setAnalysisTotals(totals) {
  $("#photoKcal").value = round(totals.kcal, 1);
  $("#photoProtein").value = round(totals.protein, 1);
  $("#photoCarbs").value = round(totals.carbs, 1);
  $("#photoFat").value = round(totals.fat, 1);
}

function renderMealAnalysis(data) {
  $("#analysisName").textContent =
    data.items.map((item) => item.name).slice(0, 3).join("、") || "饮食照片";
  $("#analysisConfidence").textContent = `${data.confidence || "中"}等置信度`;
  $("#analysisNotes").textContent = data.notes || "请按实际份量修正。";
  $("#analysisItems").replaceChildren();

  data.items.forEach((item) => {
    const row = createElement("div", "analysis-item");
    const copy = createElement("span");
    copy.append(
      createElement("strong", "", item.name),
      createElement("small", "", item.portion),
    );
    row.append(copy, createElement("b", "", `${formatNumber(item.kcal)} kcal`));
    $("#analysisItems").append(row);
  });

  $("#labelBasisPanel").hidden = true;
  setAnalysisTotals(data.totals);
}

function updateLabelTotals() {
  if (currentAnalysis?.mode !== "label") return;
  const amount = Math.max(0, Number($("#labelConsumedAmount").value) || 0);
  const factor =
    currentAnalysis.basisType === "per_serving"
      ? amount
      : amount / Math.max(1, currentAnalysis.basisAmount);
  setAnalysisTotals({
    kcal: currentAnalysis.perBasis.kcal * factor,
    protein: currentAnalysis.perBasis.protein * factor,
    carbs: currentAnalysis.perBasis.carbs * factor,
    fat: currentAnalysis.perBasis.fat * factor,
  });
}

function renderLabelAnalysis(data) {
  const isPerServing = data.basisType === "per_serving";
  const unitLabel = data.basisUnit === "ml" ? "毫升" : data.basisUnit === "份" ? "份" : "克";
  const basisLabel = isPerServing ? "每份" : `每 ${formatNumber(data.basisAmount, 1)} ${unitLabel}`;

  $("#analysisName").textContent = data.name;
  $("#analysisConfidence").textContent = `${data.confidence || "中"}等置信度`;
  $("#analysisNotes").textContent = data.notes;
  $("#analysisItems").replaceChildren();
  const row = createElement("div", "analysis-item");
  const copy = createElement("span");
  copy.append(
    createElement("strong", "", basisLabel),
    createElement(
      "small",
      "",
      `蛋白 ${formatNumber(data.perBasis.protein, 1)}g · 碳水 ${formatNumber(data.perBasis.carbs, 1)}g · 脂肪 ${formatNumber(data.perBasis.fat, 1)}g`,
    ),
  );
  row.append(copy, createElement("b", "", `${formatNumber(data.perBasis.kcal, 1)} kcal`));
  $("#analysisItems").append(row);

  $("#labelBasisPanel").hidden = false;
  $("#labelBasisText").textContent = basisLabel;
  $("#labelAmountLabel").textContent = isPerServing
    ? "实际食用份数"
    : `实际食用量（${unitLabel}）`;
  $("#labelCalculationHint").textContent = isPerServing
    ? "例如喝掉 2 份就填 2。"
    : `按实际吃掉的${unitLabel}数换算，不需要填写整包重量。`;
  $("#labelConsumedAmount").value = data.defaultAmount;
  updateLabelTotals();
}

async function analyzePhoto() {
  if (!currentPhoto?.analysisDataUrl) {
    showToast("请先拍照或选择图片。", "error");
    return;
  }

  const button = $("#analyzePhotoButton");
  button.classList.add("loading");
  button.disabled = true;

  try {
    const apiKey = localStorage.getItem(AI_KEY_STORAGE) || "";
    const baseUrl = localStorage.getItem(AI_BASE_URL_STORAGE) || state.settings.baseUrl || "";
    const model = localStorage.getItem("fitday_model_v1") || state.settings.model;
    let data;

    if (apiKey) {
      data = await requestFoodAnalysisDirect({
        baseUrl,
        apiKey,
        model,
        image: currentPhoto.analysisDataUrl,
        note: $("#photoNote").value,
        mode: photoMode,
      });
    } else {
      if (photoMode === "label") {
        throw new Error("营养成分表识别需要先配置视觉模型接口。请到“设置 > AI 接口”填写服务商信息。");
      }
      if (!canUseLocalAnalysisServer()) {
        throw new Error("还没有配置视觉模型接口。请先在“设置 > AI 接口”填写 Base URL、API Key 和视觉模型名称。");
      }
      const response = await fetch("./api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: currentPhoto.analysisDataUrl,
          note: $("#photoNote").value,
          model,
          baseUrl,
          mode: photoMode,
        }),
      });
      data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (data.error === "AI_NOT_CONFIGURED") {
          throw new Error("还没有配置视觉模型接口。请在设置中填写 Base URL、API Key 和视觉模型名称。");
        }
        throw new Error(data.message || "图像分析失败。");
      }
    }

    currentAnalysis = data;
    if (data.mode === "label") renderLabelAnalysis(data);
    else renderMealAnalysis(data);
    $("#photoResult").hidden = false;
    $("#photoResult").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    showToast(error.message || "图像分析失败。", "error");
  } finally {
    button.classList.remove("loading");
    button.disabled = false;
  }
}

async function checkAiHealth() {
  try {
    const response = await fetch("./api/health");
    const data = await response.json();
    aiServerConfigured = Boolean(data.aiConfigured);
    if (data.defaultModel && !localStorage.getItem("fitday_model_v1")) {
      state.settings.model = data.defaultModel;
      $("#settingModel").value = data.defaultModel;
    }
    if (data.defaultBaseUrl && !localStorage.getItem(AI_BASE_URL_STORAGE)) {
      state.settings.baseUrl = data.defaultBaseUrl;
      $("#settingBaseUrl").value = data.defaultBaseUrl;
    }
  } catch {
    aiServerConfigured = false;
  }
  renderSettings();
}

function exportData() {
  const payload = JSON.stringify(state, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `fitday-backup-${dateKey()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = normalizeState(JSON.parse(String(reader.result)));
      if (!Array.isArray(imported.meals) || !Array.isArray(imported.weights)) {
        throw new Error("备份内容不完整。");
      }
      state = imported;
      saveState();
      renderAll();
      showToast("备份导入成功。");
    } catch (error) {
      showToast(error.message || "无法导入备份。", "error");
    } finally {
      $("#importInput").value = "";
    }
  };
  reader.readAsText(file);
}

function bindEvents() {
  $$(".nav-button").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });

  $$("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => closeDialog(button.dataset.closeDialog));
  });

  $$(".dialog").forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog && dialog.id !== "setupDialog") dialog.close();
    });
  });

  $("#setupDialog").addEventListener("cancel", (event) => event.preventDefault());

  $("#setupForm").addEventListener("submit", (event) => {
    event.preventDefault();
    state.profile = {
      ...state.profile,
      sex: $("#setupSex").value,
      age: Number($("#setupAge").value),
      height: Number($("#setupHeight").value),
      startWeight: Number($("#setupWeight").value),
      goalRate: Number($("#setupGoalRate").value),
      activityFactor: Number($("#setupActivityFactor").value),
    };
    state.setupComplete = true;
    state.ui.lastWeightPromptDate = dateKey();
    upsertWeight(dateKey(), Number($("#setupWeight").value));
    saveState();
    closeDialog("setupDialog");
    renderAll();
    showToast("设置完成，今天的目标已经生成。");
  });

  $("#openWeightButton").addEventListener("click", () => {
    openWeightDialog(dateKey());
  });

  $("#weightForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const key = $("#weightDate").value || dateKey();
    upsertWeight(key, Number($("#weightValue").value));
    if (key === dateKey()) state.ui.lastWeightPromptDate = key;
    saveState();
    closeDialog("weightDialog");
    renderAll();
    showToast("体重已记录，趋势目标已重新计算。");
  });

  $("#openManualMealButton").addEventListener("click", () => {
    $("#mealForm").reset();
    $("#mealProtein").value = 0;
    $("#mealCarbs").value = 0;
    $("#mealFat").value = 0;
    openDialog("mealDialog");
  });

  $("#mealForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const meal = {
      id: uid("meal"),
      date: dateKey(),
      createdAt: new Date().toISOString(),
      source: "manual",
      name: safeText($("#mealName").value) || "饮食记录",
      kcal: Math.max(0, Number($("#mealKcal").value)),
      protein: Math.max(0, Number($("#mealProtein").value)),
      carbs: Math.max(0, Number($("#mealCarbs").value)),
      fat: Math.max(0, Number($("#mealFat").value)),
    };
    state.meals.push(meal);
    saveState();
    closeDialog("mealDialog");
    renderAll();
    showToast("饮食已加入今天。");
  });

  $("#openPhotoButton").addEventListener("click", () => {
    resetPhotoDialog();
    openDialog("photoDialog");
  });

  $$("[data-photo-mode]").forEach((button) => {
    button.addEventListener("click", () => setPhotoMode(button.dataset.photoMode));
  });

  $("#photoInput").addEventListener("change", async (event) => {
    const [file] = event.target.files;
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showToast("请选择图片文件。", "error");
      return;
    }

    try {
      const [analysisDataUrl, thumbnail] = await Promise.all([
        resizeImage(file, 1280, 0.82),
        resizeImage(file, 360, 0.62),
      ]);
      currentPhoto = { analysisDataUrl, thumbnail, fileName: file.name };
      $("#photoPreview").src = analysisDataUrl;
      $("#photoPreview").hidden = false;
      $("#photoPlaceholder").hidden = true;
      $("#photoResult").hidden = true;
    } catch (error) {
      showToast(error.message || "无法处理图片。", "error");
    }
  });

  $("#analyzePhotoButton").addEventListener("click", analyzePhoto);
  $("#labelConsumedAmount").addEventListener("input", updateLabelTotals);

  $("#addPhotoMealButton").addEventListener("click", () => {
    if (!currentAnalysis || !currentPhoto) {
      showToast("请先完成图片估算。", "error");
      return;
    }

    const names =
      currentAnalysis.mode === "label"
        ? currentAnalysis.name
        : currentAnalysis.items.map((item) => item.name).slice(0, 3).join("、");
    const meal = {
      id: uid("meal"),
      date: dateKey(),
      createdAt: new Date().toISOString(),
      source: "photo",
      name: names || "照片饮食记录",
      kcal: Math.max(0, Number($("#photoKcal").value)),
      protein: Math.max(0, Number($("#photoProtein").value)),
      carbs: Math.max(0, Number($("#photoCarbs").value)),
      fat: Math.max(0, Number($("#photoFat").value)),
      image: currentPhoto.thumbnail,
      confidence: currentAnalysis.confidence,
      notes: currentAnalysis.notes,
      photoMode: currentAnalysis.mode || "meal",
    };
    state.meals.push(meal);
    saveState();
    closeDialog("photoDialog");
    renderAll();
    showToast("照片估算已加入今天。");
  });

  $("#openExerciseButton").addEventListener("click", () => {
    $("#exerciseDuration").value = 45;
    $("#exerciseIntensity").value = "1";
    const lastExerciseType = state.settings.lastExerciseType;
    if (lastExerciseType && EXERCISES.some((exercise) => exercise.id === lastExerciseType)) {
      $("#exerciseType").value = lastExerciseType;
    } else {
      $("#exerciseType").selectedIndex = 0;
    }
    $("#exerciseWeight").value = "";
    $("#exerciseReps").value = 8;
    $("#exerciseSets").value = 3;
    updateExerciseEstimate();
    openDialog("exerciseDialog");
  });

  $("#exerciseType").addEventListener("change", updateExerciseEstimate);
  $("#exerciseDuration").addEventListener("input", updateExerciseEstimate);
  $("#exerciseIntensity").addEventListener("change", updateExerciseEstimate);
  ["#exerciseWeight", "#exerciseReps", "#exerciseSets"].forEach((selector) => {
    $(selector).addEventListener("input", updateStrengthVolumeHint);
  });

  $("#exerciseForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const selected = EXERCISES.find((exercise) => exercise.id === $("#exerciseType").value) || EXERCISES[0];
    const intensity = Number($("#exerciseIntensity").value || 1);
    const isStrength = selected.category === "strength";
    const duration = isStrength ? 0 : Math.max(1, Number($("#exerciseDuration").value));
    const durationSource = isStrength ? "manual_total" : "user";
    const intensityLabel = INTENSITY_GUIDES[String(intensity)]?.label || "RPE 6";
    const strengthMovement = isStrength ? $("#exerciseMovement").value : "";
    const weightKg = isStrength ? Math.max(0, Number($("#exerciseWeight").value) || 0) : 0;
    const reps = isStrength ? Math.max(1, Number($("#exerciseReps").value) || 1) : 0;
    const sets = isStrength ? Math.max(1, Number($("#exerciseSets").value) || 1) : 0;
    const localKcal = isStrength
      ? 0
      : Math.max(1, Math.round(calculateExerciseKcal(selected, duration, intensity)));

    const exercise = {
      id: uid("exercise"),
      date: dateKey(),
      createdAt: new Date().toISOString(),
      type: selected.id,
      name: selected.name,
      met: selected.met,
      duration,
      durationSource,
      intensity,
      intensityLabel,
      strengthMovement,
      weightKg,
      reps,
      sets,
      trainingVolume: weightKg > 0 ? weightKg * reps * sets : 0,
      estimateSource: isStrength ? "pending_daily_total" : "local",
      aiNotes: "",
      kcal: isStrength ? 0 : localKcal,
    };
    state.exercises.push(exercise);
    state.settings.lastExerciseType = selected.id;
    if (isStrength) syncStrengthSession(dateKey());
    saveState();
    closeDialog("exerciseDialog");
    renderAll();
    showToast(isStrength ? "动作已记录，请填写今日力量训练总时长。" : "训练已记录，今天的目标已同步增加。");
  });

  $("#mealList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-delete-meal]");
    if (!button) return;
    state.meals = state.meals.filter((meal) => meal.id !== button.dataset.deleteMeal);
    saveState();
    renderAll();
    showToast("饮食记录已删除。");
  });

  $("#exerciseList").addEventListener("click", async (event) => {
    const saveButton = event.target.closest("[data-save-strength-minutes]");
    if (saveButton) {
      await saveDailyStrengthMinutes(saveButton);
      return;
    }
    const button = event.target.closest("[data-delete-exercise]");
    if (!button) return;
    state.exercises = state.exercises.filter((exercise) => exercise.id !== button.dataset.deleteExercise);
    syncStrengthSession(dateKey());
    saveState();
    renderAll();
    showToast("训练记录已删除。");
  });

  $("#profileForm").addEventListener("submit", (event) => {
    event.preventDefault();
    state.profile = {
      ...state.profile,
      sex: $("#settingSex").value,
      age: Number($("#settingAge").value),
      height: Number($("#settingHeight").value),
      startWeight: Number($("#settingStartWeight").value),
      goalRate: Number($("#settingGoalRate").value),
      activityFactor: Number($("#settingActivityFactor").value),
      proteinPerKg: Number($("#settingProteinPerKg").value),
      fatPerKg: Number($("#settingFatPerKg").value),
    };
    saveState();
    renderAll();
    showToast("计算参数已保存。");
  });

  $("#aiForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const key = $("#settingApiKey").value.trim();
    const model = $("#settingModel").value.trim() || "gpt-4.1-mini";
    const baseUrl = $("#settingBaseUrl").value.trim().replace(/\/+$/, "");
    const thinkingMode = $("#settingThinkingMode").value || "off";
    if (key) localStorage.setItem(AI_KEY_STORAGE, key);
    else localStorage.removeItem(AI_KEY_STORAGE);
    if (baseUrl) localStorage.setItem(AI_BASE_URL_STORAGE, baseUrl);
    else localStorage.removeItem(AI_BASE_URL_STORAGE);
    localStorage.setItem("fitday_model_v1", model);
    localStorage.setItem(AI_THINKING_STORAGE, thinkingMode);
    state.settings.model = model;
    state.settings.baseUrl = baseUrl;
    saveState();
    renderSettings();
    showToast("AI 配置已保存在当前浏览器。");
  });

  $("#exportButton").addEventListener("click", exportData);
  $("#importInput").addEventListener("change", (event) => {
    const [file] = event.target.files;
    if (file) importData(file);
  });
  $("#clearButton").addEventListener("click", () => {
    if (!window.confirm("确定清空全部体重、饮食和训练记录吗？此操作无法撤销。")) return;
    localStorage.removeItem(STORAGE_KEY);
    state = clone(DEFAULT_STATE);
    saveState();
    renderAll();
    openDialog("setupDialog");
    showToast("本机记录已清空。");
  });

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    $("#installButton").hidden = false;
  });

  $("#installButton").addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    $("#installButton").hidden = true;
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    $("#installButton").hidden = true;
  });
}

async function init() {
  await restoreLocalBackupIfNeeded();
  populateExerciseSelect();
  bindEvents();
  renderAll();
  checkAiHealth();

  if (!state.setupComplete) {
    openDialog("setupDialog");
  } else {
    maybePromptDailyWeight();
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

init();
