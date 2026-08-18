const fs = require("fs");
const text = fs.readFileSync(process.argv[2] || "traces_20260818.txt", "utf8");
const runs = text.split(/^=== .*$/m).map(s => s.trim()).filter(Boolean);

const EXPECTED = { "通常": 0.21, "高品質": 0.10, "高進捗": 0.09, "高能率": 0.14, "頑丈": 0.17, "頑強": 0.10, "安定": 0.10, "長持続": 0.09 };
const condCount = {}; let condN = 0, forcedExcluded = 0;
const dice = { rapid: { s: 0, f: 0 }, rapidC: { s: 0, f: 0 }, touch: { s: 0, f: 0 }, touchC: { s: 0, f: 0 } };

for (const run of runs) {
  const rows = run.split("\n").map(l => {
    const m = l.match(/^T(\d+) \[(.+?)\] (\S+)(.*)/);
    return m ? { step: +m[1], cond: m[2], act: m[3], rest: m[4] } : null;
  }).filter(Boolean).reverse(); // chronological

  let prevStepFinalCond = null, prevStep = 0, curStep = 0, lastCondInStep = null;
  for (const r of rows) {
    if (r.step !== curStep) { // new step begins
      if (curStep > 0) prevStepFinalCond = lastCondInStep, prevStep = curStep;
      curStep = r.step; lastCondInStep = null;
    }
    const isNewSample = r.cond !== lastCondInStep; // dedupe consecutive same-cond rows in same step
    if (isNewSample) {
      const firstOfStep = lastCondInStep === null;
      const forced = firstOfStep && r.cond === "頑丈" && prevStepFinalCond === "頑強" && r.step === prevStep + 1;
      if (r.step !== 1 && !forced) { condCount[r.cond] = (condCount[r.cond] || 0) + 1; condN++; }
      if (forced) forcedExcluded++;
      lastCondInStep = r.cond;
    }
    // dice
    const fail = r.rest.includes("失敗");
    const centered = r.cond === "安定";
    if (r.act === "突貫作業") { const b = centered ? dice.rapidC : dice.rapid; fail ? b.f++ : b.s++; }
    if (r.act === "ヘイスティタッチ" || r.act === "デアリングタッチ") { const b = centered ? dice.touchC : dice.touch; fail ? b.f++ : b.s++; }
  }
}

console.log(`=== 状態出現率 (${condN}サンプル、頑強→頑丈の強制分${forcedExcluded}件は除外、T1除外) ===`);
const order = ["通常", "高品質", "高進捗", "高能率", "頑丈", "頑強", "安定", "長持続"];
for (const k of order) {
  const c = condCount[k] || 0, obs = c / condN, exp = EXPECTED[k];
  const se = Math.sqrt(exp * (1 - exp) / condN), z = (obs - exp) / se;
  console.log(`${k}\t${c}\t観測${(obs * 100).toFixed(1)}%\t想定${(exp * 100).toFixed(0)}%\tz=${z.toFixed(2)}${Math.abs(z) > 2 ? " ★有意" : ""}`);
}

console.log("\n=== ギャンブル成功率 ===");
function report(name, b, p) {
  const n = b.s + b.f; if (!n) return console.log(`${name}: サンプルなし`);
  const obs = b.s / n, se = Math.sqrt(p * (1 - p) / n), z = (obs - p) / se;
  const pv = 2 * (1 - 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2)));
  console.log(`${name}: ${b.s}/${n} = ${(obs * 100).toFixed(1)}% (想定${p * 100}%) z=${z.toFixed(2)} p値≈${pv.toFixed(3)}${Math.abs(z) > 2 ? " ★有意" : ""}`);
}
function erf(x) { const t = 1 / (1 + 0.3275911 * x); return 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); }
report("突貫(通常時50%)", dice.rapid, 0.5);
report("突貫(安定時75%)", dice.rapidC, 0.75);
report("ヘイスティ/デアリング(通常時60%)", dice.touch, 0.6);
report("ヘイスティ/デアリング(安定時85%)", dice.touchC, 0.85);
const allG = { s: dice.rapid.s + dice.rapidC.s + dice.touch.s + dice.touchC.s, f: dice.rapid.f + dice.rapidC.f + dice.touch.f + dice.touchC.f };
console.log(`\n全ギャンブル合計: ${allG.s}成功/${allG.f}失敗 (${allG.s + allG.f}回)`);
