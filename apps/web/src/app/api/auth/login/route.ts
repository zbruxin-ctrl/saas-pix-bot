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

  // NÃO setar `domain` explicitamente — o Vercel gerencia isso automaticamente.
  // Setar domain: 'saas-pix-bot.vercel.app' fazia o cookie ser rejeitado
  // nos deployments com URL diferente (saas-pix-xxx.vercel.app).
  response.cookies.set('auth_presence', '1', {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60,
    path: '/',
    // domain: omitido intencionalmente
  });

  return response;
}
