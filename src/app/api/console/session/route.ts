import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  CONSOLE_COOKIE,
  CONSOLE_TTL_SECONDS,
  passwordsMatch,
  signConsoleSession,
} from '@/lib/console-session';
import { AppError, toErrorBody } from '@/lib/errors';
import { readJsonLimited } from '@/lib/http/body';

export const dynamic = 'force-dynamic';

const BodySchema = z.object({ password: z.string().min(1).max(200) });

export async function POST(req: Request) {
  try {
    const expected = process.env.CONSOLE_PASSWORD ?? '';
    if (!expected) {
      throw new AppError('SERVER_MISCONFIG', '未配置 CONSOLE_PASSWORD');
    }

    // 与其他写路由同一条路径：chunked 请求没有 Content-Length，只有边读边计数才拦得住
    const body = await readJsonLimited(req);
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError('VALIDATION_FAILED', '请填写口令');
    }
    if (!(await passwordsMatch(parsed.data.password, expected))) {
      throw new AppError('UNAUTHORIZED', '口令不正确');
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
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return NextResponse.json(body, { status });
  }
}
