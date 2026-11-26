import { describe, expect, test } from 'vitest';
import {
  passwordsMatch,
  safeNextPath,
  signConsoleSession,
  verifyConsoleSession,
} from './console-session';

describe('控制台登录票据', () => {
  test('签出的票据能用同一口令验过，错口令不行', async () => {
    const token = await signConsoleSession('secret', 1_700_000_000_000);
    expect(await verifyConsoleSession(token, 'secret', 1_700_000_000_000)).toBe(true);
    expect(await verifyConsoleSession(token, 'other', 1_700_000_000_000)).toBe(false);
  });

  test('过期票据失败', async () => {
    const now = 1_700_000_000_000;
    const token = await signConsoleSession('secret', now);
    expect(await verifyConsoleSession(token, 'secret', now + 13 * 60 * 60 * 1000)).toBe(false);
  });

  test('空口令不能登录', async () => {
    expect(await passwordsMatch('secret', '')).toBe(false);
    expect(await passwordsMatch('', 'secret')).toBe(false);
    expect(await passwordsMatch('secret', 'secret')).toBe(true);
    expect(await passwordsMatch('secret', 'Secret')).toBe(false);
  });

  test('站外跳转地址被收成概览', () => {
    expect(safeNextPath('/incidents?status=all')).toBe('/incidents?status=all');
    expect(safeNextPath('//evil.example')).toBe('/overview');
    expect(safeNextPath('https://evil.example')).toBe('/overview');
    expect(safeNextPath('/login')).toBe('/overview');
    expect(safeNextPath(null)).toBe('/overview');
  });
});
