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

  // Cookie lido pelo middleware Next.js no servidor — deve ser lax/strict, não none
  // none só funciona cross-site; aqui o middleware e o frontend são o mesmo domínio Vercel
  response.cookies.set('auth_presence', '1', {
    httpOnly: false,      // middleware pode ler sem httpOnly no Next.js edge
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',     // lax funciona corretamente em same-site (Vercel)
    maxAge: 7 * 24 * 60 * 60,
    path: '/',
  });

  return response;
}
