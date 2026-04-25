// apps/web/src/app/api/proxy/[...path]/route.ts
// Proxy genérico: encaminha todas as chamadas /api/proxy/* para o Railway
// com o cookie auth_token, resolvendo o problema de cookies cross-domain.

import { NextRequest, NextResponse } from 'next/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

async function handler(
  request: NextRequest,
  { params }: { params: { path: string[] } }
) {
  const path = params.path.join('/');
  const url = new URL(request.url);
  const targetUrl = `${API_URL}/api/${path}${url.search}`;

  // Pega o cookie auth_token do browser e repassa para o Railway
  const authToken = request.cookies.get('auth_token')?.value;
  const cookieHeader = authToken ? `auth_token=${authToken}` : '';

  const origin = request.headers.get('origin') ||
    'https://saas-pix-bot.vercel.app';

  const headers: Record<string, string> = {
    'Content-Type': request.headers.get('content-type') || 'application/json',
    'Origin': origin.startsWith('http') ? origin : `https://${origin}`,
  };

  if (cookieHeader) {
    headers['Cookie'] = cookieHeader;
  }

  let body: string | undefined;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    body = await request.text();
  }

  const apiRes = await fetch(targetUrl, {
    method: request.method,
    headers,
    body,
  });

  const data = await apiRes.text();

  const response = new NextResponse(data, {
    status: apiRes.status,
    headers: {
      'Content-Type': apiRes.headers.get('content-type') || 'application/json',
    },
  });

  // Encaminha Set-Cookie da API (ex: logout limpa o cookie)
  const setCookie = apiRes.headers.get('set-cookie');
  if (setCookie) {
    response.headers.set('set-cookie', setCookie);
  }

  return response;
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
