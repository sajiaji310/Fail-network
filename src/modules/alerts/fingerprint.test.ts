import { describe, expect, it } from 'vitest';
import { clusterKeyOf, signatureOf } from './fingerprint';

describe('fingerprint', () => {
  it('同设备同类型同指标 → 同一指纹（与时间无关）', () => {
    const a = signatureOf('dev_1', 'LINK_DOWN', 'Gi1/0/1');
    const b = signatureOf('dev_1', 'LINK_DOWN', 'Gi1/0/1');
    expect(a).toBe(b);
    expect(a).toHaveLength(40);
  });

  it('设备/类型/指标任一不同 → 指纹不同', () => {
    const base = signatureOf('dev_1', 'LINK_DOWN', 'Gi1/0/1');
    expect(signatureOf('dev_2', 'LINK_DOWN', 'Gi1/0/1')).not.toBe(base);
    expect(signatureOf('dev_1', 'PORT_FLAP', 'Gi1/0/1')).not.toBe(base);
    expect(signatureOf('dev_1', 'LINK_DOWN', 'Gi1/0/2')).not.toBe(base);
  });

  it('clusterKey 与顺序无关、自动去重', () => {
    const a = clusterKeyOf(['f3', 'f1', 'f2']);
    const b = clusterKeyOf(['f1', 'f2', 'f3', 'f1']);
    expect(a).toBe(b);
    expect(clusterKeyOf(['f1', 'f2'])).not.toBe(a);
  });
});
