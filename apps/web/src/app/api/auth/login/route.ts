import { NextRequest, NextResponse } from 'next/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export async function POST(request: NextRequest) {
  const body = await request.json();

  const apiRes = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await apiRes.json();

  if (!apiRes.ok) {
    return NextResponse.json(data, { status: apiRes.status });
  }

  const response = NextResponse.json(data);

  // Lê o host da requisição para setar o cookie no domínio correto.
  // Isso garante que funciona tanto no alias (saas-pix-bot.vercel.app)
  // quanto no deployment direto (saas-pix-xxx.vercel.app).
  const host = request.headers.get('host') || '';
  const domain = host.split(':')[0]; // remove porta se houver

  response.cookies.set('auth_presence', '1', {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60,
    path: '/',
    domain: domain || undefined,
  });

  return response;
}
