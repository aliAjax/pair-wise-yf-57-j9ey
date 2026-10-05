import { useState } from 'react';
import { Button, Input, ScrollView, Text, Textarea, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useDispatch, useSelector } from 'react-redux';
import { useI18n } from '../../i18n';
import {
  addObservation,
  addPoint,
  addSample,
  correctPointLocal,
  demonstrateDuplicate,
  dismissNotice,
  editObservationOffline,
  resetDemo,
  resolveField,
  reviewObservation,
  runSync,
  simStationCorrectPoint,
  simStationEditObservation,
  simStationEditSample,
  switchRole,
  toggleFailInjection,
  toggleOnline,
  verifySample
} from '../../store';
import type { EntityKind, FieldConflict, SyncState } from '../../types';
import type { RootState } from '../../store';
import { RISK_LABEL, SYNC_LABEL } from '../../types';
import './index.scss';

const formSchema = z.object({
  note: z.string().min(2, '现场记录至少写两个字'),
  risk: z.enum(['low', 'medium', 'high']),
  species: z.string(),
  count: z.string()
});
type FormValues = z.infer<typeof formSchema>;

const FIELD_LABEL: Record<string, string> = {
  note: '现场备注',
  risk: '风险等级',
  latitude: '纬度',
  longitude: '经度',
  code: '样本编号',
  species: '物种名称',
  count: '数量'
};

const formatValue = (field: string, value: string) =>
  field === 'risk' ? RISK_LABEL[value as keyof typeof RISK_LABEL] ?? value : value;

function SyncTag({ state }: { state: SyncState }) {
  return <Text className={`tag tag-${state}`}>{SYNC_LABEL[state]}</Text>;
}

function ConflictRows({
  kind,
  clientId,
  conflicts,
  isManager,
  onResolve
}: {
  kind: EntityKind;
  clientId: string;
  conflicts: Record<string, FieldConflict>;
  isManager: boolean;
  onResolve: (field: string, choice: 'local' | 'remote') => void;
}) {
  return (
    <View className="conflict-fields">
      {Object.entries(conflicts).map(([field, pair]) => (
        <View className="conflict-field" key={field}>
          <Text className="conflict-name">同一字段「{FIELD_LABEL[field] ?? field}」两边都改了：</Text>
          <View className="conflict-versions">
            <Text className="version version-local">巡护员：{formatValue(field, pair.local)}</Text>
            <Text className="version version-remote">站里：{formatValue(field, pair.remote)}</Text>
          </View>
          {isManager ? (
            <View className="conflict-actions">
              <Button size="mini" onClick={() => onResolve(field, 'local')}>留巡护员版</Button>
              <Button size="mini" onClick={() => onResolve(field, 'remote')}>留站里版</Button>
            </View>
          ) : (
            <Text className="deny-hint">巡护员无权裁决，已保留两份内容，等负责人确认。</Text>
          )}
        </View>
      ))}
    </View>
  );
}

export default function Index() {
  const t = useI18n();
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.patrol);
  const isManager = state.role === 'manager';
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editNote, setEditNote] = useState('');
  const [correctId, setCorrectId] = useState<string | null>(null);
  const [correctLat, setCorrectLat] = useState('');
  const [correctLng, setCorrectLng] = useState('');

  const { register, handleSubmit, reset } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { note: '', risk: 'low', species: '', count: '1' }
  });

  const pendingCount =
    state.observations.filter((item) => item.sync === 'queued' || item.sync === 'failed').length +
    state.points.filter((item) => item.sync === 'queued' || item.sync === 'failed').length +
    state.samples.filter((item) => item.sync === 'queued' || item.sync === 'failed').length;
  const failedCount =
    state.observations.filter((item) => item.sync === 'failed').length +
    state.points.filter((item) => item.sync === 'failed').length +
    state.samples.filter((item) => item.sync === 'failed').length;
  const conflictCount =
    state.observations.filter((item) => item.sync === 'conflict').length +
    state.points.filter((item) => item.sync === 'conflict').length +
    state.samples.filter((item) => item.sync === 'conflict').length;

  const recordPoint = async () => {
    try {
      const result = await Taro.getLocation({ type: 'gcj02' });
      dispatch(addPoint({ latitude: Number(result.latitude.toFixed(6)), longitude: Number(result.longitude.toFixed(6)) }));
    } catch {
      dispatch(addPoint({ latitude: Number((30.58 + Math.random() * 0.02).toFixed(6)), longitude: Number((103.21 + Math.random() * 0.02).toFixed(6)) }));
    }
  };

  const submit = (values: FormValues) => {
    dispatch(addObservation({ note: values.note, risk: values.risk }));
    if (values.species) {
      dispatch(
        addSample({
          code: `WD-${Date.now().toString().slice(-5)}`,
          species: values.species,
          count: Number(values.count) || 1
        })
      );
    }
    reset();
  };

  const resolve = (kind: EntityKind, clientId: string, field: string, choice: 'local' | 'remote') =>
    dispatch(resolveField({ kind, clientId, field, choice }));

  const startCorrect = (clientId: string, lat: number, lng: number) => {
    setCorrectId(clientId);
    setCorrectLat(String(lat + 0.005));
    setCorrectLng(String(lng + 0.005));
  };

  return (
    <View className="page">
      <View className="hero">
        <Text className="eyebrow">FIELD PATROL / 离线逐条合并</Text>
        <Text className="title">{t.title}</Text>
        <Text className="sub">无信号离线记录，回网后逐条与站里版本做字段级合并；同字段冲突保留两份，等负责人确认。</Text>
      </View>

      {/* 身份与网络 */}
      <View className="card control-card">
        <View className="role-switch">
          <Text className="card-label">当前身份</Text>
          <View className="seg">
            <Button size="mini" className={!isManager ? 'seg-on' : ''} onClick={() => dispatch(switchRole('ranger'))}>巡护员</Button>
            <Button size="mini" className={isManager ? 'seg-on' : ''} onClick={() => dispatch(switchRole('manager'))}>站点负责人</Button>
          </View>
        </View>
        <View className="role-switch">
          <Text className="card-label">网络状态</Text>
          <View className="seg">
            <Button size="mini" className={state.online ? 'seg-on' : ''} onClick={() => dispatch(toggleOnline())}>
              {state.online ? '已联网' : '无信号区'}
            </Button>
            <Button size="mini" onClick={() => dispatch(toggleFailInjection())}>
              {state.failNextMidSync ? '取消断连模拟' : '模拟下次中途断连'}
            </Button>
          </View>
        </View>
        <Text className="hint">{isManager ? '负责人权限：复核、核验、冲突裁决、坐标修正。' : '巡护员只能记录/编辑自己的现场内容；复核、核验、裁决、改坐标都会被拒绝。'}</Text>
      </View>

      {state.notice && (
        <View className="alert notice">
          <Text>{state.notice}</Text>
          <Button size="mini" onClick={() => dispatch(dismissNotice())}>知道了</Button>
        </View>
      )}

      <View className="metrics">
        <View><Text>轨迹点</Text><Text className="metric">{state.points.length}</Text></View>
        <View><Text>待传/未传完</Text><Text className="metric warn">{pendingCount}</Text></View>
        <View><Text>冲突待裁决</Text><Text className="metric danger">{conflictCount}</Text></View>
        <View><Text>样本</Text><Text className="metric">{state.samples.length}</Text></View>
      </View>

      {/* 同步 */}
      <View className="card">
        <View className="card-title">
          {t.sync}
          <Text className="count">{pendingCount} 条排队{failedCount > 0 ? ` · ${failedCount} 条未传完` : ''}</Text>
        </View>
        <Button className="primary" onClick={() => dispatch(runSync())} disabled={!state.online}>
          {failedCount > 0 ? '重试没传完的记录并继续合并' : '回网：逐条上传并与站里合并'}
        </Button>
        <Button className="secondary" onClick={() => dispatch(demonstrateDuplicate())}>
          幂等演示：把一条已同步记录再传一次
        </Button>
        {state.lastSyncReport && <Text className="report">{state.lastSyncReport}</Text>}
        <Text className="hint">
          按「客户端ID」幂等上传：已同步的重复上传不会多出一份；中途失败后只重试 queued/未传完的记录，已成功的不会重传。
        </Text>
      </View>

      {/* 现场记录 */}
      <View className="card">
        <View className="card-title">现场记录（离线可填）</View>
        <form onSubmit={handleSubmit(submit)}>
          <Textarea className="textarea" placeholder="记录观察、痕迹、设备问题或现场风险" {...register('note', { required: true })} />
          <View className="two">
            <Input className="input" placeholder="物种或样本名称（可选）" {...register('species')} />
            <Input className="input" type="number" placeholder="数量" {...register('count')} />
          </View>
          <View className="risk">
            <Text>风险等级</Text>
            <select {...register('risk')}>
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
            </select>
          </View>
          <Button className="primary" formType="submit">{t.save}</Button>
          <Button className="secondary" onClick={recordPoint}>记录当前轨迹点</Button>
        </form>
      </View>

      {/* 冲突裁决 */}
      {conflictCount > 0 && (
        <View className="card conflict-card">
          <View className="card-title">字段冲突 · 等负责人确认</View>
          {[...state.observations, ...state.points, ...state.samples]
            .filter((item) => item.sync === 'conflict')
            .map((item) => (
              <View className="conflict-block" key={`${item.kind}-${item.clientId}`}>
                <Text className="conflict-head">
                  {item.kind === 'observation' ? '观察记录' : item.kind === 'point' ? '轨迹点' : '样本'} {item.clientId}
                </Text>
                <ConflictRows
                  kind={item.kind}
                  clientId={item.clientId}
                  conflicts={item.conflicts}
                  isManager={isManager}
                  onResolve={(field, choice) => resolve(item.kind, item.clientId, field, choice)}
                />
              </View>
            ))}
        </View>
      )}

      {/* 观察记录 */}
      <View className="card">
        <View className="card-title">观察记录</View>
        <ScrollView scrollY className="list">
          {state.observations.map((item) => (
            <View className="record" key={item.clientId}>
              <View className="record-main">
                <Text className="obs-title">
                  {item.risk === 'high' ? '高风险 · ' : ''}{item.note}
                </Text>
                <Text className="muted">
                  {item.time} · 关联轨迹点 {item.pointId ?? '无'} · {RISK_LABEL[item.risk]}风险
                </Text>
                <View className="tag-row">
                  <SyncTag state={item.sync} />
                  {item.dirtyFields.map((field) => (
                    <Text className="tag tag-dirty" key={field}>本地改过:{FIELD_LABEL[field] ?? field}</Text>
                  ))}
                  {item.reviewed ? <Text className="tag tag-reviewed">负责人已复核</Text> : <Text className="tag tag-pending">待负责人复核</Text>}
                </View>
                {Object.keys(item.conflicts).length > 0 && (
                  <ConflictRows
                    kind="observation"
                    clientId={item.clientId}
                    conflicts={item.conflicts}
                    isManager={isManager}
                    onResolve={(field, choice) => resolve('observation', item.clientId, field, choice)}
                  />
                )}
                {editingId === item.clientId ? (
                  <View className="inline-edit">
                    <Textarea className="textarea" value={editNote} onInput={(event) => setEditNote(event.detail.value)} />
                    <View className="inline-actions">
                      <Button size="mini" onClick={() => {
                        if (editNote.trim().length >= 2) {
                          dispatch(editObservationOffline({ clientId: item.clientId, note: editNote.trim() }));
                          setEditingId(null);
                        }
                      }}>保存离线改动</Button>
                      <Button size="mini" onClick={() => setEditingId(null)}>取消</Button>
                    </View>
                  </View>
                ) : (
                  <Button size="mini" className="ghost" onClick={() => { setEditingId(item.clientId); setEditNote(item.note); }}>
                    巡护员离线改备注
                  </Button>
                )}
              </View>
              <Button
                size="mini"
                className={item.reviewed ? 'done' : 'review-btn'}
                disabled={item.reviewed || item.sync === 'conflict'}
                onClick={() => dispatch(reviewObservation(item.clientId))}
              >
                {item.reviewed ? '已复核' : isManager ? '复核' : '复核（将被拒绝）'}
              </Button>
            </View>
          ))}
        </ScrollView>
      </View>

      {/* 轨迹点 */}
      <View className="card">
        <View className="card-title">轨迹点 · 坐标版本联动样本核验</View>
        {state.points.map((point) => (
          <View className="record" key={point.clientId}>
            <View className="record-main">
              <Text className="obs-title">{point.latitude.toFixed(4)}, {point.longitude.toFixed(4)}</Text>
              <Text className="muted">{point.at} · {point.source} · 坐标版本 v{point.coordVersion}</Text>
              <View className="tag-row"><SyncTag state={point.sync} /></View>
              {Object.keys(point.conflicts).length > 0 && (
                <ConflictRows
                  kind="point"
                  clientId={point.clientId}
                  conflicts={point.conflicts}
                  isManager={isManager}
                  onResolve={(field, choice) => resolve('point', point.clientId, field, choice)}
                />
              )}
              {correctId === point.clientId ? (
                <View className="inline-edit">
                  <View className="two">
                    <Input className="input" value={correctLat} onInput={(event) => setCorrectLat(event.detail.value)} placeholder="纬度" />
                    <Input className="input" value={correctLng} onInput={(event) => setCorrectLng(event.detail.value)} placeholder="经度" />
                  </View>
                  <View className="inline-actions">
                    <Button size="mini" onClick={() => {
                      const lat = Number(correctLat);
                      const lng = Number(correctLng);
                      if (Number.isFinite(lat) && Number.isFinite(lng)) {
                        dispatch(correctPointLocal({ clientId: point.clientId, latitude: lat, longitude: lng }));
                        setCorrectId(null);
                      }
                    }}>确认修正（级联作废）</Button>
                    <Button size="mini" onClick={() => setCorrectId(null)}>取消</Button>
                  </View>
                </View>
              ) : (
                <Button size="mini" className="ghost" onClick={() => startCorrect(point.clientId, point.latitude, point.longitude)}>
                  修正坐标（仅负责人）
                </Button>
              )}
            </View>
          </View>
        ))}
        <Text className="hint">坐标一变：关联样本的核验结论立即作废并按新坐标自动重算（待负责人确认），关联观察的复核也需重新确认。</Text>
      </View>

      {/* 样本 */}
      <View className="card">
        <View className="card-title">样本 · 核验结论</View>
        {state.samples.map((sample) => (
          <View className="record" key={sample.clientId}>
            <View className="record-main">
              <Text className="obs-title">{sample.code} · {sample.species} × {sample.count}</Text>
              <Text className="muted">挂在轨迹点 {sample.pointId} · 依据坐标版本 v{sample.coordVersion}</Text>
              <Text className="verify-note">核验结论：{sample.verifyNote}</Text>
              {sample.verifiedBy && <Text className="muted">核验人：{sample.verifiedBy}</Text>}
              <View className="tag-row">
                <SyncTag state={sample.sync} />
                {sample.status === 'verified'
                  ? <Text className="tag tag-reviewed">已核验</Text>
                  : <Text className="tag tag-pending">待负责人核验</Text>}
              </View>
              {Object.keys(sample.conflicts).length > 0 && (
                <ConflictRows
                  kind="sample"
                  clientId={sample.clientId}
                  conflicts={sample.conflicts}
                  isManager={isManager}
                  onResolve={(field, choice) => resolve('sample', sample.clientId, field, choice)}
                />
              )}
            </View>
            <Button
              size="mini"
              className={sample.status === 'verified' ? 'done' : 'review-btn'}
              disabled={sample.status === 'verified' || sample.sync === 'conflict'}
              onClick={() => dispatch(verifySample(sample.clientId))}
            >
              {sample.status === 'verified' ? '已核验' : isManager ? '核验' : '核验（将被拒绝）'}
            </Button>
          </View>
        ))}
      </View>

      {/* 站里端模拟 */}
      <View className="card station-card">
        <View className="card-title">站里端模拟（制造合并场景）</View>
        <Text className="hint">o1 本地没动，只改站里 → 同步时没动的字段跟站里值走；o3 两边都改备注 → 字段冲突留两份。</Text>
        <Button size="mini" className="secondary" onClick={() => dispatch(simStationEditObservation({ clientId: 'o1', note: '东坡足迹群持续向溪谷上游移动，已安排明日补查（站里端更新）' }))}>
          站里只改 o1 备注（远端单独改）
        </Button>
        <Button size="mini" className="secondary" onClick={() => dispatch(simStationEditObservation({ clientId: 'o3', note: '南段复核完毕，确认无异常（站里端版本）' }))}>
          站里改 o3 备注（与本地冲突）
        </Button>
        <Button size="mini" className="secondary" onClick={() => dispatch(simStationEditSample({ clientId: 's1', species: '确认豹猫毛发（站里端定名）' }))}>
          站里改 s1 物种名
        </Button>
        <Button size="mini" className="secondary" onClick={() => dispatch(simStationCorrectPoint({ clientId: 'p1', latitude: 30.5905, longitude: 103.2286 }))}>
          站里把 p1 坐标移出登记样线（核验作废重算）
        </Button>
        <Button size="mini" className="danger-ghost" onClick={() => dispatch(resetDemo())}>重置全部演示数据</Button>
      </View>
    </View>
  );
}
