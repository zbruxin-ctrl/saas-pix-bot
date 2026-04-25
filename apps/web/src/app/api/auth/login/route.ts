import { NextRequest, NextResponse } from 'next/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export async function POST(request: NextRequest) {
  const body = await request.json();

  // Passa o Origin do request original para a API do Railway.
  // Sem isso, o fetch servidor-a-servidor não envia Origin e a API rejeita por CORS.
  const origin = request.headers.get('origin') || 
                 request.headers.get('host') || 
                 'https://saas-pix-bot.vercel.app';

  const apiRes = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': origin.startsWith('http') ? origin : `https://${origin}`,
    },
    body: JSON.stringify(body),
  });

  const data = await apiRes.json();

  if (!apiRes.ok) {
    return NextResponse.json(data, { status: apiRes.status });
  }

  const response = NextResponse.json(data);

  // Encaminha o Set-Cookie que a API enviou (auth_token httpOnly)
  const setCookie = apiRes.headers.get('set-cookie');
  if (setCookie) {
    response.headers.set('set-cookie', setCookie);
  }

  // Cookie de presença para o middleware do Next.js
  response.cookies.set('auth_presence', '1', {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60,
    path: '/',
  });

  return response;
}
