import { NextResponse } from 'next/server';

export async function POST() {
  const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

  try {
    // Chama o logout no backend para invalidar o token
    await fetch(`${API_URL}/api/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    });
  } catch (_) {
    // Continua mesmo se o backend falhar
  }

  // Remove o cookie de presença no Next.js (não-httpOnly)
  const response = NextResponse.json({ ok: true });
  response.cookies.set('auth_presence', '', {
    maxAge: 0,
    path: '/',
    sameSite: 'lax',
  });

  return response;
}
