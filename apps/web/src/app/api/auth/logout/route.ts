import { NextResponse } from 'next/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export async function POST(request: Request) {
  // Tenta invalidar sessão na API backend (ignora falhas — logout local sempre ocorre)
  try {
    const cookie = request.headers.get('cookie') || '';
    await fetch(`${API_URL}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie },
      credentials: 'include',
    });
  } catch (_) {
    // silencia erros de rede — logout local continua
  }

  const response = NextResponse.json({ ok: true });

  // Remove cookie de presença
  response.cookies.set('auth_presence', '', {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  });

  return response;
}
