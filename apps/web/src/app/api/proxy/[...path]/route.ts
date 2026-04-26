import { NextRequest, NextResponse } from 'next/server';

const API_URL =
  process.env.API_URL ||
  process.env.NEXT_PUBLIC_API_URL ||
  'https://api-production-a596.up.railway.app';

function extractJwt(raw: string): string {
  const decoded = decodeURIComponent(raw);
  if (decoded.startsWith('s:')) {
    const withoutPrefix = decoded.slice(2);
    const parts = withoutPrefix.split('.');
    if (parts.length >= 4) {
      return parts.slice(0, 3).join('.');
    }
    return withoutPrefix;
  }
  return raw;
}

async function proxyRequest(request: NextRequest, method: string): Promise<NextResponse> {
  const url = request.nextUrl;
  const segments = url.pathname.replace('/api/proxy/', '');
  const targetUrl = `${API_URL}/api/${segments}${url.search}`;

  const rawToken = request.cookies.get('auth_token')?.value;
  const authToken = rawToken ? extractJwt(rawToken) : null;

  // LOG DE DEBUG — remover apos diagnostico
  console.log('[proxy] rawToken:', rawToken ? rawToken.slice(0, 60) + '...' : 'NENHUM');
  console.log('[proxy] authToken:', authToken ? authToken.slice(0, 60) + '...' : 'NENHUM');
  console.log('[proxy] target:', targetUrl);

  const headers: Record<string, string> = {
    'Content-Type': request.headers.get('content-type') || 'application/json',
  };

  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) headers['x-forwarded-for'] = forwarded;

  let body: BodyInit | undefined;
  if (!['GET', 'HEAD', 'DELETE'].includes(method)) {
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('multipart/form-data')) {
      body = await request.formData();
      delete headers['Content-Type'];
    } else {
      const text = await request.text();
      body = text || undefined;
    }
  }

  try {
    const apiRes = await fetch(targetUrl, { method, headers, body });
    const responseBody = await apiRes.text();

    // LOG DE DEBUG
    console.log('[proxy] api status:', apiRes.status);
    if (apiRes.status >= 400) {
      console.log('[proxy] api response:', responseBody.slice(0, 200));
    }

    const response = new NextResponse(responseBody, {
      status: apiRes.status,
      statusText: apiRes.statusText,
    });

    const ct = apiRes.headers.get('content-type');
    if (ct) response.headers.set('content-type', ct);

    return response;
  } catch (error) {
    console.error('[proxy] fetch error:', targetUrl, error);
    return NextResponse.json(
      { success: false, error: 'Erro de conexao com a API' },
      { status: 503 }
    );
  }
}

export async function GET(request: NextRequest) {
  return proxyRequest(request, 'GET');
}
export async function POST(request: NextRequest) {
  return proxyRequest(request, 'POST');
}
export async function PUT(request: NextRequest) {
  return proxyRequest(request, 'PUT');
}
export async function PATCH(request: NextRequest) {
  return proxyRequest(request, 'PATCH');
}
export async function DELETE(request: NextRequest) {
  return proxyRequest(request, 'DELETE');
}
