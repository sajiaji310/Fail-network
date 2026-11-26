import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  CONSOLE_COOKIE,
  CONSOLE_TTL_SECONDS,
  passwordsMatch,
  signConsoleSession,
} from '@/lib/console-session';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({ password: z.string().min(1).max(200) });

export async function POST(req: Request) {
  const expected = process.env.CONSOLE_PASSWORD ?? '';
  if (!expected) {
    return NextResponse.json(
      { error: { code: 'SERVER_MISCONFIG', message: '未配置 CONSOLE_PASSWORD' } },
      { status: 500 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'VALIDATION_FAILED', message: '请求体不是合法 JSON' } },
      { status: 400 },
    );
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'VALIDATION_FAILED', message: '请填写口令' } },
      { status: 400 },
    );
  }
  if (!(await passwordsMatch(parsed.data.password, expected))) {
    return NextResponse.json(
      { error: { code: 'UNAUTHORIZED', message: '口令不正确' } },
      { status: 401 },
    );
  }

  const token = await signConsoleSession(expected);
  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: CONSOLE_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: 'lax',
    secure: new URL(req.url).protocol === 'https:',
    path: '/',
    maxAge: CONSOLE_TTL_SECONDS,
  });
  return response;
}
