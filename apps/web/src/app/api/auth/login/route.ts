import { NextRequest, NextResponse } from 'next/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// Extrai o valor de um cookie de uma string Set-Cookie
function extractCookieValue(setCookieHeader: string, name: string): string | null {
  for (const part of setCookieHeader.split(',')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) {
      return trimmed.split(';')[0].split('=').slice(1).join('=');
    }
  }
  return null;
}

export async function POST(request: NextRequest) {
  const body = await request.json();

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
  const isProduction = process.env.NODE_ENV === 'production';

  // Extrai todos os Set-Cookie headers da API
  // A API envia auth_token (httpOnly, signed) e auth_presence
  // NÃO repassamos o Set-Cookie do Railway direto — o browser descartaria
  // por domain mismatch. Recriamos os cookies no domínio do Next.js.
  const setCookieHeaders = apiRes.headers.getSetCookie
    ? apiRes.headers.getSetCookie()
    : [apiRes.headers.get('set-cookie') ?? ''];

  let authToken: string | null = null;

  for (const header of setCookieHeaders) {
    if (!header) continue;
    // auth_token pode vir como "auth_token=s%3AJWT..." (signed com s%3A)
    if (header.includes('auth_token=')) {
      authToken = header.split(';')[0].split('=').slice(1).join('=');
    }
  }

  if (authToken) {
    // Recria o cookie auth_token no domínio Vercel (.vercel.app)
    response.cookies.set('auth_token', authToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60,
      path: '/',
    });
  }

  // Cookie de presença (não-httpOnly) para o middleware do Next.js detectar sessão
  response.cookies.set('auth_presence', '1', {
    httpOnly: false,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60,
    path: '/',
  });

  return response;
}
