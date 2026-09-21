import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db';
import { createProject, importVersion, addAnnotation, getComparisonDetail } from '../service';

const V1 = '第一条 总则。\n\n第二条 应当在四十八小时内报告。\n\n第三条 罚则内容甲。';
const V2 = '第一条 总则。\n\n第二条 应当在二十四小时内报告。\n\n第三条 罚则内容甲，并处一万元罚款。';
// v3：第二条再次改写（批注应迁移）；第三条未变化（无对应片段，批注应转待复核）
const V3 = '第一条 总则。\n\n第二条 应当立即处置，并在二十四小时内报告。\n\n第三条 罚则内容甲，并处一万元罚款。';

function setup() {
  const db = openDb(':memory:');
  const pid = createProject(db, '测试办法');
  importVersion(db, pid, 'v1', V1);
  const r2 = importVersion(db, pid, 'v2', V2);
  if (r2.status !== 'ok') throw new assert.AssertionError({ message: `v2 导入失败：${r2.status}` });
  return { db, pid, r2 };
}

test('导入首个版本不产生比对，导入第二版本生成差异片段', () => {
  const { db, r2 } = setup();
  assert.ok(r2.comparisonId != null);
  const frags = db
    .prepare('SELECT * FROM fragments WHERE comparison_id = ? ORDER BY ord')
    .all(r2.comparisonId) as Array<{ type: string }>;
  assert.equal(frags.length, 2);
  assert.ok(frags.every((f) => f.type === 'changed'));
});

test('未解决批注迁移到最相近片段，无法匹配的标为待复核，已解决的不迁移', () => {
  const { db, pid, r2 } = setup();
  const comparisonId2 = r2.comparisonId!;
  const frags = db
    .prepare('SELECT * FROM fragments WHERE comparison_id = ?')
    .all(comparisonId2) as Array<{ id: number; new_text: string }>;
  const frag2 = frags.find((f) => f.new_text.includes('二十四小时'))!;
  const frag3 = frags.find((f) => f.new_text.includes('一万元'))!;

  const note = (fragId: number, author: string, content: string): number => {
    const r = addAnnotation(db, fragId, author, content);
    assert.equal(r.status, 'ok');
    return r.status === 'ok' ? r.id : -1;
  };

  note(frag2.id, '甲', '时限压缩需确认'); // v3 中第二条仍相近 → 应迁移
  note(frag3.id, '乙', '罚款额度待确认'); // v3 中第三条无变化 → 无片段 → 待复核
  const resolvedId = note(frag3.id, '丙', '已确认无异议');
  db.prepare(`UPDATE annotations SET status = 'resolved' WHERE id = ?`).run(resolvedId);

  const r3 = importVersion(db, pid, 'v3', V3);
  if (r3.status !== 'ok') throw new assert.AssertionError({ message: `v3 导入失败：${r3.status}` });
  assert.equal(r3.migration!.total, 2);
  assert.equal(r3.migration!.migrated, 1);
  assert.equal(r3.migration!.pending, 1);
  assert.equal(r3.migration!.skip_reason, null);
  assert.equal(r3.migration!.source_comparison_id, comparisonId2);

  const detail = getComparisonDetail(db, r3.comparisonId!)!;
  assert.equal(detail.stats.annotations.total, 2);

  const migrated = detail.fragments.flatMap((f) => f.annotations);
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].author, '甲');
  assert.equal(migrated[0].status, 'open');
  assert.ok(migrated[0].similarity! >= 0.4);
  assert.ok(migrated[0].migrated_from != null);

  assert.equal(detail.unanchored.length, 1);
  assert.equal(detail.unanchored[0].author, '乙');
  assert.equal(detail.unanchored[0].status, 'pending_review');
  assert.ok(detail.unanchored[0].anchor_text!.includes('一万元'));
});

test('锚点与新片段完全一致时相似度为 1', () => {
  const { db, pid, r2 } = setup();
  const frags = db
    .prepare('SELECT * FROM fragments WHERE comparison_id = ?')
    .all(r2.comparisonId!) as Array<{ id: number; new_text: string }>;
  const frag2 = frags.find((f) => f.new_text.includes('二十四小时'))!;
  const r = addAnnotation(db, frag2.id, '甲', '待办');
  assert.equal(r.status, 'ok');

  // v3 与 v2 的第二条完全相同 → 该段无变化不会产生片段；
  // 构造一个 v3 仅修改第一条的场景，第二条批注应转待复核
  const V3b = '第一条 总则（2026 年修订）。\n\n第二条 应当在二十四小时内报告。\n\n第三条 罚则内容甲，并处一万元罚款。';
  const r3 = importVersion(db, pid, 'v3', V3b);
  if (r3.status !== 'ok') throw new assert.AssertionError({ message: `v3 导入失败：${r3.status}` });
  assert.equal(r3.migration!.total, 1);
  assert.equal(r3.migration!.migrated, 0);
  assert.equal(r3.migration!.pending, 1);
});
