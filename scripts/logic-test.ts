import assert from 'node:assert/strict';
import { store } from '../src/store/index.ts';
import {
  addObservation,
  addPoint,
  addSample,
  correctPointLocal,
  demonstrateDuplicate,
  editObservationOffline,
  resetDemo,
  resolveField,
  reviewObservation,
  runSync,
  simStationCorrectPoint,
  simStationEditObservation,
  switchRole,
  toggleFailInjection,
  verifySample
} from '../src/store/index.ts';
import { mem } from './taro-stub.ts';

let count = 0;
const ok = (name: string) => {
  count += 1;
  console.log(`  ✓ ${name}`);
};

const patrol = () => store.getState().patrol;
const findObs = (id: string) => patrol().observations.find((item) => item.clientId === id)!;
const findPoint = (id: string) => patrol().points.find((item) => item.clientId === id)!;
const findSample = (id: string) => patrol().samples.find((item) => item.clientId === id)!;
const stationData = () => JSON.parse(mem.get('yf57-station-state') || '{}');

function scenario(name: string, fn: () => void) {
  console.log(`\n[场景] ${name}`);
  fn();
}

// 初始化种子：o1/o2/p1/p2/s1 已同步；o3/p3/s2/o4 queued
store.dispatch(resetDemo());

// ---- 场景 1：远端单独改字段，本地没动 → 跟站里值走 ----
scenario('站里只改了字段、本地没动：没动的字段跟站里值走', () => {
  store.dispatch(simStationEditObservation({ clientId: 'o1', note: '站里单方面更新的备注A' }));
  const before = findObs('o1').note;
  assert.notEqual(before, '站里单方面更新的备注A', '同步前本地仍是旧值');
  store.dispatch(runSync());
  // o1 是 synced，走只拉取通道
  assert.equal(findObs('o1').note, '站里单方面更新的备注A', '本地自动采用站里值');
  assert.equal(findObs('o1').sync, 'synced', '拉取后保持已同步，没有进队列');
  assert.equal(stationData().observations.length, 3 + 1, '站里原有 o1/o2/o3，加上本地新增 o4，共 4 条');
  ok('o1 备注自动跟站里值，状态仍为已同步');
});

// ---- 场景 2：两边改同一字段 → 留两份，等负责人确认 ----
scenario('同一字段两边都改：保留两份内容，巡护员无权裁决，负责人确认后合并', () => {
  store.dispatch(resetDemo());
  // 种子里站里 o3 备注为「样线南段没有异常」，站里再改成新的站里版本
  store.dispatch(simStationEditObservation({ clientId: 'o3', note: '南段站里版本B' }));
  // 本地 o3 种子已是「样线南段没有异常，仅见零星鸟羽」（queued）
  store.dispatch(runSync());
  const o3 = findObs('o3');
  assert.equal(o3.sync, 'conflict', 'o3 进入冲突态');
  assert.ok(o3.conflicts.note, 'note 字段冲突被记录');
  assert.equal(o3.conflicts.note.remote, '南段站里版本B', '保留站里版本');
  assert.ok(o3.conflicts.note.local.includes('鸟羽'), '保留巡护员版本');

  // 巡护员尝试裁决 → 被拒绝
  store.dispatch(switchRole('ranger'));
  store.dispatch(resolveField({ kind: 'observation', clientId: 'o3', field: 'note', choice: 'local' }));
  assert.ok(findObs('o3').conflicts.note, '巡护员裁决不生效，冲突仍在');
  assert.match(patrol().notice ?? '', /越权拒绝/, '提示越权拒绝');

  // 负责人裁决取本地
  store.dispatch(switchRole('manager'));
  store.dispatch(resolveField({ kind: 'observation', clientId: 'o3', field: 'note', choice: 'local' }));
  const after = findObs('o3');
  assert.equal(Object.keys(after.conflicts).length, 0, '冲突已清空');
  assert.equal(after.sync, 'synced', '裁决后已同步');
  assert.ok(after.note.includes('鸟羽'), '最终取巡护员版本');
  assert.equal(stationData().observations.find((x: any) => x.clientId === 'o3').note, after.note, '站里只保存最终的一份');
  ok('两份内容均保留 → 巡护员裁决被拒 → 负责人确认后写回站里且只有一份');
});

// ---- 场景 3：幂等，重复上传不会多出一份 ----
scenario('已同步内容重复上传：站里识别重复，不多出一份', () => {
  store.dispatch(resetDemo());
  store.dispatch(runSync()); // 先让全部记录落站
  const countBefore = stationData().observations.length;
  store.dispatch(demonstrateDuplicate());
  const countAfter = stationData().observations.length;
  assert.equal(countAfter, countBefore, '站里记录总数不变');
  assert.match(patrol().notice ?? '', /总数不变/, '提示重复被丢弃');
  // 连续再来一次仍然不变
  store.dispatch(demonstrateDuplicate());
  assert.equal(stationData().observations.length, countBefore, '再次重复上传总数仍不变');
  ok('两次重复上传，站里总数保持不变');
});

// ---- 场景 4：同步中途失败，只重试没传完的 ----
scenario('中途断连：成功的不重传，只补传没传完的记录', () => {
  store.dispatch(resetDemo());
  // 种子队列：o3(观察)、p3(轨迹)、s2(样本)、o4(观察)
  const queuedBefore = ['o3', 'p3', 's2', 'o4']
    .map((id) => findObs(id) ?? findPoint(id) ?? findSample(id))
    .map((d) => d.sync);
  assert.deepEqual(queuedBefore, ['queued', 'queued', 'queued', 'queued'], '种子队列均为 queued');

  store.dispatch(toggleFailInjection());
  store.dispatch(runSync()); // 第一条（o3）传完后断连
  assert.equal(findObs('o3').sync, 'synced', 'o3 已传成功');
  assert.ok(['p3', 's2', 'o4'].every((id) => {
    const d = (findObs(id) as any) ?? (findPoint(id) as any) ?? (findSample(id) as any);
    return d.sync === 'failed';
  }), '其余三条标记为未传完');
  assert.match(patrol().lastSyncReport ?? '', /中途断连/, '报告说明中途断连');

  // 重试：只补传 failed 的三条；o3 不再重传
  store.dispatch(runSync());
  assert.equal(findPoint('p3').sync, 'synced', 'p3 补传成功');
  assert.equal(findSample('s2').sync, 'synced', 's2 补传成功');
  assert.equal(findObs('o4').sync, 'synced', 'o4 补传成功');
  assert.equal(findObs('o3').sync, 'synced', 'o3 依然只存在一份');
  const s = stationData();
  assert.equal(s.observations.length, 4, '站里观察共 4 条，无重复');
  assert.equal(s.points.length, 3, '站里轨迹点共 3 条，无重复');
  assert.equal(s.samples.length, 2, '站里样本共 2 条，无重复');
  ok('断点续传后全部成功且站里无重复记录');
});

// ---- 场景 5：轨迹点坐标一变，样本核验作废重算、复核重新确认 ----
scenario('站里修正坐标：样本核验结论作废重算，观察复核重新确认', () => {
  store.dispatch(resetDemo());
  // s1 已核验挂在 p1；o1 挂在 p1（种子 reviewed=false，先让负责人复核通过并同步）
  store.dispatch(switchRole('manager'));
  store.dispatch(runSync()); // 先把队列清空
  store.dispatch(reviewObservation('o1'));
  assert.equal(findObs('o1').reviewed, true, 'o1 已复核');
  // 站里把 p1 移出登记样线范围
  store.dispatch(simStationCorrectPoint({ clientId: 'p1', latitude: 30.9, longitude: 103.9 }));
  assert.equal(stationData().samples.find((x: any) => x.clientId === 's1').status, 'submitted', '站里 s1 核验作废');
  assert.equal(stationData().observations.find((x: any) => x.clientId === 'o1').reviewed, false, '站里 o1 复核重置');

  store.dispatch(runSync()); // 拉取
  const p1 = findPoint('p1');
  assert.equal(p1.coordVersion, 2, '坐标版本到 v2');
  assert.equal(p1.latitude, 30.9, '坐标已拉取');
  const s1 = findSample('s1');
  assert.equal(s1.status, 'submitted', '本地 s1 核验作废 → 待重新核验');
  assert.equal(s1.verifiedBy, '', '核验人被清空');
  assert.match(s1.verifyNote, /偏离登记样线/, '结论已按新坐标自动重算');
  assert.equal(findObs('o1').reviewed, false, '本地 o1 需要负责人重新复核');

  // 负责人重新核验后，再次改坐标应再次作废
  store.dispatch(verifySample('s1'));
  assert.equal(findSample('s1').status, 'verified', '重新核验通过');
  store.dispatch(simStationCorrectPoint({ clientId: 'p1', latitude: 30.585, longitude: 103.22 }));
  store.dispatch(runSync());
  assert.equal(findSample('s1').status, 'submitted', '坐标再变，核验再次作废');
  assert.equal(findPoint('p1').coordVersion, 3, '坐标版本到 v3');
  assert.match(findSample('s1').verifyNote, /位于登记样线内/, '新坐标在样线内，自动重算结论成立待确认');
  ok('坐标变更级联：核验作废+自动重算、复核重置，再次变更再次作废');
});

// ---- 场景 6：本地负责人修正坐标也触发级联，并能同步到站里 ----
scenario('本地修正坐标：立即级联作废，同步后站里一致', () => {
  store.dispatch(resetDemo());
  store.dispatch(switchRole('manager'));
  store.dispatch(runSync()); // 清空队列，全部已同步
  store.dispatch(reviewObservation('o1'));
  store.dispatch(verifySample('s1'));
  assert.equal(findSample('s1').status, 'verified');
  store.dispatch(correctPointLocal({ clientId: 'p1', latitude: 30.95, longitude: 103.95 }));
  assert.equal(findPoint('p1').coordVersion, 2, '本地坐标版本+1');
  assert.equal(findPoint('p1').sync, 'queued', '轨迹点重新进入队列');
  assert.equal(findSample('s1').status, 'submitted', '样本立即作废');
  assert.match(findSample('s1').verifyNote, /偏离登记样线/, '本地即时重算');
  assert.equal(findSample('s1').sync, 'queued', '样本作废结果也要回传站里');
  assert.equal(findObs('o1').reviewed, false, '观察复核立即重置');

  store.dispatch(runSync());
  assert.equal(findPoint('p1').sync, 'synced', '轨迹点已同步');
  assert.equal(findSample('s1').sync, 'synced', '样本作废结果已同步');
  assert.equal(stationData().points.find((x: any) => x.clientId === 'p1').coordVersion, 2, '站里坐标版本一致');
  assert.equal(stationData().samples.find((x: any) => x.clientId === 's1').status, 'submitted', '站里样本也已作废');
  assert.equal(stationData().observations.find((x: any) => x.clientId === 'o1').reviewed, false, '站里观察复核也重置');
  assert.equal(stationData().points.length, 3, 'p1/p2/p3 共 3 个轨迹点');
  assert.equal(stationData().points.filter((x: any) => x.clientId === 'p1').length, 1, 'p1 在站里只有一份，坐标修正走更新而非新增');
  ok('本地坐标修正级联生效且同步后两端一致、无重复');
});

// ---- 场景 7：巡护员越权复核/核验/改坐标 → 拒绝 ----
scenario('巡护员越权：复核、核验、裁决、改坐标全部被拒绝', () => {
  store.dispatch(resetDemo());
  store.dispatch(switchRole('ranger'));
  store.dispatch(runSync());

  store.dispatch(reviewObservation('o1'));
  assert.equal(findObs('o1').reviewed, false, '复核没有生效');
  assert.match(patrol().notice ?? '', /越权拒绝.*复核/, '提示复核越权');

  store.dispatch(verifySample('s2'));
  assert.equal(findSample('s2').status, 'submitted', '待核验样本没有被巡护员核验');
  assert.match(patrol().notice ?? '', /越权拒绝.*样本核验/, '提示核验越权');
  const s1VerifierBefore = findSample('s1').verifiedBy;
  store.dispatch(verifySample('s1'));
  assert.equal(findSample('s1').verifiedBy, s1VerifierBefore, '已核验样本的核验人也不会被越权改写');
  store.dispatch(correctPointLocal({ clientId: 'p1', latitude: 31, longitude: 104 }));
  assert.equal(findPoint('p1').latitude, 30.5821, '坐标没有被修改');
  assert.match(patrol().notice ?? '', /越权拒绝.*坐标/, '提示改坐标越权');

  // 巡护员离线改自己的备注应当允许（只影响自己可改字段）
  store.dispatch(editObservationOffline({ clientId: 'o1', note: '巡护员现场补充备注C' }));
  assert.equal(findObs('o1').note, '巡护员现场补充备注C', '巡护员可改现场备注');
  assert.equal(findObs('o1').sync, 'queued', '改动进入同步队列');
  ok('越权操作全部拒绝且不留副作用；正常的现场编辑仍允许');
});

// ---- 场景 8：无信号不能同步，记录留在本地 ----
scenario('无信号区：记录只进本地队列，不同步', () => {
  store.dispatch(resetDemo());
  store.dispatch(switchRole('ranger'));
  // 直接切到离线
  store.dispatch({ type: 'patrol/toggleOnline' });
  assert.equal(patrol().online, false);
  store.dispatch(addObservation({ note: '无信号时记录的新观察D', risk: 'high' }));
  store.dispatch(addPoint({ latitude: 30.591, longitude: 103.226 }));
  store.dispatch(addSample({ code: 'WD-X-09', species: '羽毛', count: 1 }));
  store.dispatch(runSync());
  assert.match(patrol().notice ?? '', /无信号/, '无信号时拒绝同步');
  const newObs = patrol().observations.find((item) => item.note.includes('新观察D'))!;
  assert.equal(newObs.sync, 'queued', '观察留在本地队列');
  assert.equal(stationData().observations.find((x: any) => x.note?.includes('新观察D')), undefined, '站里没有这条');
  ok('离线记录安全保留在本地，回网后才能上传');
});

console.log(`\n全部 ${count} 项断言通过 ✅`);
