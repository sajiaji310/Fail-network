import { describe, expect, it } from 'vitest';
import { classifyAlertType, isParentAlertType, isSuppressible } from './taxonomy';

describe('告警类型分类（抑制规则的守卫）', () => {
  it('设备不可达类是父告警', () => {
    expect(classifyAlertType('DEVICE_UNREACHABLE')).toBe('PARENT');
    expect(classifyAlertType('device_down')).toBe('PARENT'); // 大小写不敏感
    expect(isParentAlertType('AGENT_UNREACHABLE')).toBe(true);
  });

  it('设备级硬件故障是根因线索，永不可抑制（AC-19）', () => {
    for (const type of [
      'LINECARD_FAILURE',
      'CHASSIS_FAILURE',
      'FAN_FAILURE',
      'POWER_SUPPLY_FAILURE',
      'TEMPERATURE_HIGH',
    ]) {
      expect(classifyAlertType(type)).toBe('ROOT');
      expect(isSuppressible(type)).toBe(false);
    }
  });

  it('端口/链路/指标类是子告警，可被父告警压制（AC-02）', () => {
    for (const type of [
      'LINK_DOWN',
      'PORT_FLAP',
      'CRC_ERROR',
      'OPTICAL_RX_LOW',
      'BGP_NEIGHBOR_DOWN',
      'PACKET_LOSS',
      'HIGH_LATENCY',
      'DNS_TIMEOUT',
      'CPU_HIGH',
    ]) {
      expect(classifyAlertType(type)).toBe('CHILD');
      expect(isSuppressible(type)).toBe(true);
    }
  });

  it('未登记的新类型保守放行，不抑制', () => {
    expect(classifyAlertType('SOMETHING_NEW')).toBe('UNKNOWN');
    expect(isSuppressible('SOMETHING_NEW')).toBe(false);
  });

  it('父告警自己不会被抑制（父告警之间并列，不互相压制）', () => {
    expect(isSuppressible('DEVICE_UNREACHABLE')).toBe(false);
  });
});
