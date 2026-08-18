// mc.mjs — aqueduct ヘッドレス・モンテカルロハーネス (Node ESM / Node v24)
//
// aqueduct/index.html のエンジン (<script> ブロック) を無改変ファイルのまま読み込み、
// DOM スタブ上で実行して recommendCore() (ドクトリンv3) に自動プレイさせる。
// CP閾値 (コンボ継続 vs ヘイスティ切替) をソース変換で外出しし、閾値スイープの勝率を出す。
//
// 使い方:
//   node mc.mjs --parity                                        # パリティ検証のみ
//   node mc.mjs --runs 1000 --thresholds 100,120,140 --seed 42 --out results
//
// index.html は一切変更しない (読み取り専用)。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(__dir, "..", "index.html");

/* ================= CLI ================= */
function parseArgs(argv) {
  const o = { runs: 1000, thresholds: [140], seed: 42, out: "results", parity: false, brain: "core" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--parity") o.parity = true;
    else if (a === "--runs") o.runs = parseInt(argv[++i], 10);
    else if (a === "--thresholds") o.thresholds = argv[++i].split(",").map((s) => parseInt(s, 10));
    else if (a === "--seed") o.seed = parseInt(argv[++i], 10);
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--brain") o.brain = argv[++i]; // core=recommendCore(生ドクトリン) / safe=recommend(UIと同じwouldDie安全網つき)
    else throw new Error("unknown arg: " + a);
  }
  if (o.brain !== "core" && o.brain !== "safe") throw new Error("--brain must be core|safe");
  if (!Number.isInteger(o.runs) || o.runs <= 0) throw new Error("--runs invalid");
  if (o.thresholds.some((t) => !Number.isInteger(t))) throw new Error("--thresholds invalid");
  return o;
}

/* ================= エンジンのロード ================= */
function extractEngineSource(html) {
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m, best = null;
  while ((m = re.exec(html)) !== null) {
    if (best === null || m[1].length > best.length) best = m[1];
  }
  if (best === null || best.trim().length === 0) {
    throw new Error("engine <script> block not found in " + HTML_PATH);
  }
  return best;
}

function transformSource(src) {
  // v5.1以降: エンジン側が COMBO_FLOOR 定数（既定9999=コンボ封印）を持つ。
  // --thresholds はこの定数の上書きとしてスイープに使う
  const NEEDLE = "let COMBO_FLOOR = 9999;";
  const parts = src.split(NEEDLE);
  const count = parts.length - 1;
  if (count !== 1) {
    throw new Error(
      `expected exactly 1 occurrence of "${NEEDLE}" in engine source, found ${count}. ` +
      "index.html のコードが変わった可能性。mc.mjs の置換ロジックを見直すこと。"
    );
  }
  return parts.join("let COMBO_FLOOR = HASTY_CP_THRESHOLD;");
}

// DOMスタブ: エンジンのロード時実行コード (readSettings / newState / localStorage復元 / render)
// が例外を出さずに通ることだけを保証する。設定入力欄はプレイヤー実効値をプリセットし、
// readSettings() がどこで呼ばれても正しい player になるようにする。
const PRELUDE = `"use strict";
var __elemCache = Object.create(null);
var __presetValues = { "in-craft": "5799", "in-control": "5637", "in-cp": "791" }; // 実効値直接入力方式（2026-08-18改修）
var __presetChecked = {};
function __makeElem(id) {
  return {
    id: id,
    value: (__presetValues[id] !== undefined ? __presetValues[id] : ""),
    checked: (__presetChecked[id] !== undefined ? __presetChecked[id] : false),
    innerHTML: "", textContent: "", disabled: false,
    style: { display: "none", width: "", background: "", setProperty: function () {} },
    classList: { toggle: function () {}, add: function () {}, remove: function () {}, contains: function () { return false; } },
    addEventListener: function () {},
  };
}
const document = {
  getElementById: function (id) {
    if (!__elemCache[id]) __elemCache[id] = __makeElem(id);
    return __elemCache[id];
  },
  addEventListener: function () {},
};
const localStorage = { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} };
const window = { addEventListener: function () {}, document: document };
const navigator = { clipboard: { writeText: function () { return { then: function () { return this; }, catch: function () { return this; } }; } } };
const alert = function () {};
let HASTY_CP_THRESHOLD = 140;
`;

// エンジン評価後に実行: ヘッドレス化してエンジン内部バインディングへの窓口を返す
const EPILOGUE = `;
followMode = false;          // 状態抽選・成功判定を自動化 (endStep / doAction の分岐参照)
render = function () {};     // 以後の描画は完全に無効化 (ロード時の初回renderはスタブで吸収済み)
return {
  get st() { return st; },
  set st(v) { st = v; },
  get threshold() { return COMBO_FLOOR; },
  set threshold(v) { HASTY_CP_THRESHOLD = v; COMBO_FLOOR = v; },
  set follow(v) { followMode = v; },
  resetAux: function () { undoStack = []; pendingRapid = null; forcedRoll = null; },
  newState: newState, rollCondition: rollCondition, canUse: canUse,
  cpCost: cpCost, durCost: durCost, progGain: progGain, qualGain: qualGain,
  doAction: doAction, recommendCore: recommendCore, recommend: recommend,
  baseProg: baseProg, baseQual: baseQual, effCraft: effCraft, effControl: effControl, maxCP: maxCP,
  A: A, ACTIONS: ACTIONS, RECIPE: RECIPE, CONDITIONS: CONDITIONS,
  get player() { return player; },
};
`;

function loadEngine() {
  const html = readFileSync(HTML_PATH, "utf8");
  const engine = transformSource(extractEngineSource(html));
  const body = PRELUDE + "\n" + engine + "\n" + EPILOGUE;
  // 同一 Function ボディで連結実行: エンジンのトップレベル let/const を epilogue と共有する
  const eng = new Function(body)();
  return eng;
}

/* ================= 乱数 (シード付きPRNG) ================= */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ORIG_RANDOM = Math.random;

/* ================= 1本の自動プレイ ================= */
const TURN_CAP = 70;   // st.step がこれを超えたら打ち切り
const ITER_CAP = 200;  // 設計変更等のステップ非消費手を含めた総イテレーション安全弁
const ROLL_ACTIONS = new Set(["hastyTouch", "daringTouch", "rapidSynth"]);

function playOne(eng, threshold, seed, brain = "core") {
  eng.threshold = threshold;
  Math.random = mulberry32(seed);
  eng.resetAux();
  eng.st = eng.newState();
  const st = eng.st;
  const R = eng.RECIPE;

  const actions = [];
  const fails = { hastyTouch: 0, daringTouch: 0, rapidSynth: 0 };
  let outcome = null, detail = "";
  let iter = 0;

  while (true) {
    if (st.finished || st.failed) break;
    // ハーネス側の打ち切りは「死因」ではなく測定系のアーティファクトとして別枠計上する
    if (st.step > TURN_CAP) { outcome = "harness_artifact"; detail = "turn_cap: step>" + TURN_CAP; break; }
    if (++iter > ITER_CAP) { outcome = "harness_artifact"; detail = "turn_cap: iter>" + ITER_CAP; break; }
    // 安全弁: followMode=false なら本来到達しないが、awaitCond が立っていたら自前で抽選
    if (st.awaitCond) { st.awaitCond = false; st.condition = eng.rollCondition(); }

    const rec = brain === "safe" ? eng.recommend() : eng.recommendCore();
    if (!rec || !eng.A[rec.id]) { outcome = "harness_artifact"; detail = "no recommendation"; break; }
    if (!eng.canUse(eng.A[rec.id])) { outcome = "harness_artifact"; detail = "canUse=false: " + rec.id; break; }

    const histLen = st.history.length;
    eng.doAction(rec.id);
    if (st.history.length === histLen) { outcome = "harness_artifact"; detail = "doAction no-op: " + rec.id; break; }

    actions.push(rec.id);
    if (ROLL_ACTIONS.has(rec.id) && st.history[0].detail.includes("失敗")) fails[rec.id]++;
  }

  // 死因分類 (finishCraft は品質未達だと finished と failed を両方立てるので finished を先に見る)
  const qShort = Math.max(0, R.requiredQuality - st.quality);
  const lethalAction = actions.length ? actions[actions.length - 1] : "(none)";
  const phase = st.progress < R.difficulty - 3500 ? "progress_phase" : "quality_phase";
  if (outcome === null) {
    if (st.finished) {
      if (st.quality >= R.requiredQuality) outcome = "win";
      else {
        outcome = "finish_quality_short";
        detail = qShort < 1000 ? "short<1000" : qShort <= 3000 ? "short1000-3000" : "short>3000";
      }
    } else if (st.failed && st.durability <= 0) {
      // 耐久死は「死亡時CP帯 × manipulation残 × 致死アクション」で分類する。
      // フェーズ分割 (progress/quality) は真因 (CP経済崩壊・致死推奨) を隠すため主分類にしない (phase フィールドで参考出力)。
      outcome = "durability_death";
      const cpBand = st.cp < 20 ? "cp<20" : st.cp < 100 ? "cp20-99" : "cp>=100";
      const manip = st.buffs.manipulation > 0 ? "manip" + st.buffs.manipulation : "manip0";
      detail = `${cpBand}|${manip}|${lethalAction}`;
    } else {
      // st.failed かつ耐久>0: エンジン上あり得ないはずの状態。測定系異常として別枠へ
      outcome = "harness_artifact";
      detail = "failed without durability=0";
    }
  }

  return {
    seed, threshold, outcome, detail, phase,
    step: st.step, progress: st.progress, quality: st.quality,
    durability: st.durability, cp: st.cp,
    qShort, manipLeft: st.buffs.manipulation,
    last3: actions.slice(-3),
    fails,
    finished: st.finished,
    actions,
    // st.history 由来のトレース (unshift格納なので反転して時系列に)
    history: st.history.slice().reverse().map(
      (h) => `T${h.step} [${h.cond}] ${h.act} ${h.detail}${h.snap ? " | " + h.snap : ""}`
    ),
  };
}

/* ================= パリティ検証 (実機実測との一致) ================= */
function runParity(eng) {
  const errs = [];
  const eq = (label, got, want) => {
    if (got !== want) errs.push(`${label}: got ${got}, want ${want}`);
    else console.log(`  OK  ${label} === ${want}`);
  };

  // ステータス前提
  eq("effCraft()", eng.effCraft(), 5799);
  eq("effControl()", eng.effControl(), 5637);
  eq("maxCP()", eng.maxCP(), 791);
  // 1-2. 基礎値
  eq("baseProg()", eng.baseProg(), 324);
  eq("baseQual()", eng.baseQual(), 348);

  // 3. 開幕確信 (eff300) の工数ゲイン 972
  Math.random = mulberry32(1);
  eng.resetAux();
  eng.st = eng.newState();
  eng.doAction("muscleMemory");
  eq("muscleMemory opening prog gain", eng.st.progress, 972);

  // 4. 確信バフ中 × 高進捗(malleable) の下地作業 (耐久充足) = floor(324*3.6*1.5*2.0) = 3499
  eng.st.condition = "malleable";
  const p0 = eng.st.progress;
  eng.doAction("groundwork");
  eq("groundwork gain (muscleMemory x malleable)", eng.st.progress - p0, 3499);

  // 5. 加工コンボCP: 加工18 → 中級18(コンボ) → 上級18(コンボ)
  eng.resetAux();
  eng.st = eng.newState();
  eng.st.condition = "normal";
  eq("cpCost(basicTouch)", eng.cpCost(eng.A.basicTouch), 18);
  let cp = eng.st.cp;
  eng.doAction("basicTouch");
  eq("basicTouch actual CP spent", cp - eng.st.cp, 18);
  eng.st.condition = "normal"; // endStepの抽選結果(pliant等)を打ち消してコンボ価格だけを見る
  eq("cpCost(standardTouch after basicTouch)", eng.cpCost(eng.A.standardTouch), 18);
  cp = eng.st.cp;
  eng.doAction("standardTouch");
  eq("standardTouch actual CP spent", cp - eng.st.cp, 18);
  eng.st.condition = "normal";
  eq("cpCost(advancedTouch after standardTouch)", eng.cpCost(eng.A.advancedTouch), 18);
  cp = eng.st.cp;
  eng.doAction("advancedTouch");
  eq("advancedTouch actual CP spent", cp - eng.st.cp, 18);

  Math.random = ORIG_RANDOM;
  return errs;
}

// CONDITIONS 出現率: rollCondition() 20,000サンプルが期待値±2ptに収まるか
function runCondCheck(eng) {
  const N = 20000, TOL = 0.02;
  Math.random = mulberry32(20260818);
  const counts = Object.create(null);
  for (const k of Object.keys(eng.CONDITIONS)) counts[k] = 0;
  for (let i = 0; i < N; i++) counts[eng.rollCondition()]++;
  Math.random = ORIG_RANDOM;
  const errs = [];
  for (const [k, c] of Object.entries(eng.CONDITIONS)) {
    const f = counts[k] / N;
    const diff = Math.abs(f - c.p);
    const line = `${k}: sampled ${(f * 100).toFixed(2)}% vs expected ${(c.p * 100).toFixed(0)}% (diff ${(diff * 100).toFixed(2)}pt)`;
    if (diff > TOL) errs.push(line);
    else console.log("  OK  " + line);
  }
  return errs;
}

/* ================= 集計 ================= */
function wilson95(wins, n) {
  if (n === 0) return [0, 0];
  const z = 1.959963984540054;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return [(center - margin) / denom, (center + margin) / denom];
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
function median(xs) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function summarize(threshold, results) {
  const n = results.length;
  const genuine = results.filter((r) => r.outcome !== "harness_artifact");
  const artifacts = results.filter((r) => r.outcome === "harness_artifact");
  const wins = results.filter((r) => r.outcome === "win").length;
  const [lo, hi] = wilson95(wins, n);
  // 死因ヒストグラムは「盤面上の本物の終わり方」のみ。ハーネス打ち切りは別枠 (harnessArtifacts)
  const causes = {};
  for (const r of genuine) {
    const key = r.outcome + (r.outcome === "durability_death" || r.outcome === "finish_quality_short" ? ":" + r.detail : "");
    causes[key] = (causes[key] || 0) + 1;
  }
  const artifactCauses = {};
  for (const r of artifacts) artifactCauses[r.detail] = (artifactCauses[r.detail] || 0) + 1;
  const finishers = results.filter((r) => r.finished);
  const quals = results.map((r) => r.quality);
  return {
    threshold,
    runs: n,
    // 第一目的関数: 品質分布と完走率 (勝率は退化しうるため主指標にしない)
    quality: {
      mean: mean(quals),
      median: median(quals),
      max: Math.max(...quals),
    },
    finishRate: finishers.length / n,
    finishers: {
      count: finishers.length,
      qualityMean: mean(finishers.map((r) => r.quality)),
      qualityMedian: median(finishers.map((r) => r.quality)),
      qualityMax: finishers.length ? Math.max(...finishers.map((r) => r.quality)) : null,
    },
    wins,
    winRate: wins / n,
    wilson95: [lo, hi],
    causes,
    harnessArtifacts: {
      count: artifacts.length,
      share: artifacts.length / n,
      causes: artifactCauses,
      note: "recommend系がCP不足等で打てない技を推奨→ハーネス打ち切り等。実UIでは発生しない測定系の吸収状態であり死因ではない",
    },
    avgSteps: mean(results.map((r) => r.step)),
    avgFails: {
      hastyTouch: mean(results.map((r) => r.fails.hastyTouch)),
      daringTouch: mean(results.map((r) => r.fails.daringTouch)),
      rapidSynth: mean(results.map((r) => r.fails.rapidSynth)),
    },
  };
}

/* 共通乱数法 (CRN) のペア差統計: run i は全閾値で同一シードなので、
   閾値a/bの run i 同士を対応させた差の平均±ペアSEで比較する (周辺CI比較より分散が桁違いに小さい) */
function pairedDiff(aRes, bRes, metricFn) {
  const n = Math.min(aRes.length, bRes.length);
  if (n < 2) return null;
  const diffs = new Array(n);
  for (let i = 0; i < n; i++) diffs[i] = metricFn(aRes[i]) - metricFn(bRes[i]);
  const m = mean(diffs);
  const varr = diffs.reduce((s, d) => s + (d - m) * (d - m), 0) / (n - 1);
  const se = Math.sqrt(varr / n);
  return { meanDiff: m, pairedSE: se, ci95: [m - 1.96 * se, m + 1.96 * se], n };
}

function pairedComparisons(thresholds, resultsByThr) {
  const out = [];
  for (let i = 0; i < thresholds.length; i++) {
    for (let j = i + 1; j < thresholds.length; j++) {
      const a = thresholds[i], b = thresholds[j];
      const ra = resultsByThr.get(a), rb = resultsByThr.get(b);
      out.push({
        thresholds: [a, b],
        note: `metric(thr=${a}) - metric(thr=${b})、共通シードによるペア差`,
        quality: pairedDiff(ra, rb, (r) => r.quality),
        finishRate: pairedDiff(ra, rb, (r) => (r.finished ? 1 : 0)),
        winRate: pairedDiff(ra, rb, (r) => (r.outcome === "win" ? 1 : 0)),
        avgSteps: pairedDiff(ra, rb, (r) => r.step),
      });
    }
  }
  return out;
}

function traceClass(r) {
  if (r.outcome === "durability_death") return "durability_death_" + r.detail;
  if (r.outcome === "harness_artifact") return "harness_artifact_" + r.detail.replace(/[:\s]+/g, "_");
  return r.outcome;
}

/* ================= メイン ================= */
function main() {
  const opt = parseArgs(process.argv.slice(2));
  const eng = loadEngine();

  console.log("=== parity check (実機実測との一致) ===");
  const perrs = runParity(eng);
  console.log("=== CONDITIONS distribution check (20,000 rolls, ±2pt) ===");
  const cerrs = runCondCheck(eng);
  if (perrs.length || cerrs.length) {
    for (const e of [...perrs, ...cerrs]) console.error("  FAIL " + e);
    console.error("parity/condition check FAILED — abort");
    process.exitCode = 1;
    return;
  }
  console.log("parity: ALL PASSED");
  if (opt.parity) return;

  const outDir = join(__dir, opt.out);
  mkdirSync(outDir, { recursive: true });

  const summaries = [];
  const traces = {}; // class -> up to 3 representative traces
  // CRNペア差用: 閾値ごとに軽量化した結果 (quality/finished/outcome/step) を保持
  const slimByThr = new Map();
  const T0 = Date.now();

  try {
    for (const thr of opt.thresholds) {
      const results = [];
      const jsonl = [];
      for (let i = 0; i < opt.runs; i++) {
        // 共通乱数法: run i のシードは seedBase+i で全閾値共通 (閾値間比較の分散低減)
        const r = playOne(eng, thr, opt.seed + i, opt.brain);
        results.push(r);
        jsonl.push(JSON.stringify({
          seed: r.seed, thr: r.threshold, outcome: r.outcome, detail: r.detail, phase: r.phase,
          step: r.step, prog: r.progress, qual: r.quality, dur: r.durability, cp: r.cp,
          qShort: r.qShort, manip: r.manipLeft, last3: r.last3.join(">"),
          fails: `${r.fails.hastyTouch}/${r.fails.daringTouch}/${r.fails.rapidSynth}`,
          acts: r.actions.join(","),
        }));
        const cls = traceClass(r);
        if (!traces[cls]) traces[cls] = [];
        if (traces[cls].length < 3) {
          traces[cls].push({
            threshold: r.threshold, seed: r.seed, outcome: r.outcome, detail: r.detail,
            final: { step: r.step, progress: r.progress, quality: r.quality, durability: r.durability, cp: r.cp, iqManipLeft: r.manipLeft },
            actions: r.actions,
            history: r.history,
          });
        }
      }
      writeFileSync(join(outDir, `runs_${thr}.jsonl`), jsonl.join("\n") + "\n", "utf8");
      slimByThr.set(thr, results.map((r) => ({ quality: r.quality, finished: r.finished, outcome: r.outcome, step: r.step })));
      const s = summarize(thr, results);
      summaries.push(s);
      const topCauses = Object.entries(s.causes).sort((a, b) => b[1] - a[1]).slice(0, 5);
      console.log(
        `thr=${thr}: finish ${(s.finishRate * 100).toFixed(1)}% ` +
        `qualMean=${s.quality.mean.toFixed(0)} qualMed=${s.quality.median} qualMax=${s.quality.max} | ` +
        `win ${s.wins}/${s.runs} (95%CI ${(s.wilson95[0] * 100).toFixed(2)}-${(s.wilson95[1] * 100).toFixed(2)}%) | ` +
        `artifacts ${s.harnessArtifacts.count} (${(s.harnessArtifacts.share * 100).toFixed(1)}%) avgSteps=${s.avgSteps.toFixed(1)}`
      );
      console.log("  causes(genuine, top5): " + JSON.stringify(Object.fromEntries(topCauses)));
      if (s.harnessArtifacts.count > 0) console.log("  harness artifacts: " + JSON.stringify(s.harnessArtifacts.causes));
    }
  } finally {
    Math.random = ORIG_RANDOM;
  }

  // CRNペア差統計 (閾値間比較の本命。周辺CIの見比べは分散が大きすぎて差が埋もれる)
  const paired = pairedComparisons(opt.thresholds, slimByThr);
  if (paired.length) {
    console.log("=== paired comparisons (CRN, metric(a)-metric(b) ± paired SE) ===");
    for (const p of paired) {
      console.log(
        `thr ${p.thresholds[0]} vs ${p.thresholds[1]}: ` +
        `qual ${p.quality.meanDiff.toFixed(1)}±${p.quality.pairedSE.toFixed(1)} | ` +
        `finish ${(p.finishRate.meanDiff * 100).toFixed(2)}±${(p.finishRate.pairedSE * 100).toFixed(2)}pt | ` +
        `steps ${p.avgSteps.meanDiff.toFixed(2)}±${p.avgSteps.pairedSE.toFixed(2)}`
      );
    }
  }

  // 勝率メトリクスの退化検知: 全セルで勝利0なら第一報として明示する
  const reqQ = eng.RECIPE.requiredQuality;
  const totalRuns = summaries.reduce((s, x) => s + x.runs, 0);
  const totalWins = summaries.reduce((s, x) => s + x.wins, 0);
  const maxQual = Math.max(...summaries.map((x) => x.quality.max));
  let headline;
  if (totalWins === 0) {
    headline = {
      winMetricDegenerate: true,
      totalWins, totalRuns,
      maxQualityObserved: maxQual,
      requiredQuality: reqQ,
      qualityGap: reqQ - maxQual,
      message:
        `全${totalRuns}本で勝利0。観測品質最大値${maxQual}は必達ライン${reqQ}に${reqQ - maxQual}届いていない。` +
        `ドクトリンv3自動プレイ(brain=${opt.brain})は人間プレイの代理として品質を大幅に過小評価しており、` +
        `勝率とそのWilson CIは閾値比較の意思決定に使えない(信号ゼロ)。` +
        `閾値選定には quality(平均/中央値)・finishRate と pairedComparisons(CRNペア差)を使うこと。`,
    };
    console.log("!!! WIN METRIC DEGENERATE: " + headline.message);
  } else {
    headline = { winMetricDegenerate: false, totalWins, totalRuns, maxQualityObserved: maxQual, requiredQuality: reqQ };
  }

  const summary = {
    headline,
    meta: {
      generatedAt: new Date().toISOString(),
      engine: "aqueduct/index.html (read-only, st.cp>=140 -> threshold param x2)",
      doctrine: "v3 autoplay (brain=" + opt.brain + ": core=recommendCore raw / safe=recommend with wouldDie guard)",
      brain: opt.brain,
      player: { craft: 5799, control: 5637, maxCP: 791 },
      runsPerThreshold: opt.runs,
      seedBase: opt.seed,
      thresholds: opt.thresholds,
      turnCap: TURN_CAP,
      iterCap: ITER_CAP,
      parity: "passed",
      objectiveNote: "第一目的関数は品質分布(quality.mean/median)と完走率(finishRate)。勝率は headline.winMetricDegenerate=true の間は意思決定に使わないこと",
      elapsedMs: Date.now() - T0,
    },
    perThreshold: summaries,
    pairedComparisons: paired,
  };
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");
  writeFileSync(join(outDir, "traces.json"), JSON.stringify(traces, null, 2), "utf8");
  console.log(`done in ${((Date.now() - T0) / 1000).toFixed(1)}s -> ${outDir}`);
}

main();
