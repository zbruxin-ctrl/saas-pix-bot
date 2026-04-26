import { NextRequest, NextResponse } from 'next/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

async function proxyRequest(request: NextRequest, method: string): Promise<NextResponse> {
  const url = request.nextUrl;
  const segments = url.pathname.replace('/api/proxy/', '');
  const targetUrl = `${API_URL}/api/${segments}${url.search}`;

  // Extrai o auth_token do cookie (setado pelo Next.js login route)
  const authToken = request.cookies.get('auth_token')?.value;

  const headers: Record<string, string> = {
    'Content-Type': request.headers.get('content-type') || 'application/json',
  };

  // Envia o token como Bearer — o middleware do Railway (auth.ts)
  // aceita tanto cookie quanto Authorization: Bearer
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  // Repassa headers úteis
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) headers['x-forwarded-for'] = forwarded;

  let body: BodyInit | undefined;
  if (!['GET', 'HEAD', 'DELETE'].includes(method)) {
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('multipart/form-data')) {
      // Repassa form-data sem re-serializar; remove Content-Type para
      // deixar o fetch definir o boundary correto
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

    const response = new NextResponse(responseBody, {
      status: apiRes.status,
      statusText: apiRes.statusText,
    });

    // Repassa Content-Type da resposta
    const ct = apiRes.headers.get('content-type');
    if (ct) response.headers.set('content-type', ct);

    return response;
  } catch (error) {
    console.error('[proxy] fetch error:', error);
    return NextResponse.json(
      { success: false, error: 'Erro de conexão com a API' },
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
