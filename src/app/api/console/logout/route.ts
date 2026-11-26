import { NextResponse } from 'next/server';
import { CONSOLE_COOKIE } from '@/lib/console-session';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const response = NextResponse.redirect(new URL('/login', req.url), 303);
  response.cookies.set({
    name: CONSOLE_COOKIE,
    value: '',
    httpOnly: true,
    sameSite: 'lax',
    secure: new URL(req.url).protocol === 'https:',
    path: '/',
    maxAge: 0,
  });
  return response;
}
