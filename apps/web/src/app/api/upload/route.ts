import { NextRequest, NextResponse } from 'next/server';

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME!;
const API_KEY = process.env.CLOUDINARY_API_KEY!;
const API_SECRET = process.env.CLOUDINARY_API_SECRET!;

function getSignature(paramsToSign: Record<string, string>, apiSecret: string) {
  const crypto = require('crypto');
  const signatureBase = Object.entries(paramsToSign)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  return crypto
    .createHash('sha1')
    .update(signatureBase + apiSecret)
    .digest('hex');
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const mediaType = String(formData.get('mediaType') || 'IMAGE');

    if (!file) {
      return NextResponse.json({ error: 'Arquivo não enviado.' }, { status: 400 });
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    const timestamp = String(Math.floor(Date.now() / 1000));

    let resourceType = 'image';
    if (mediaType === 'VIDEO') resourceType = 'video';
    if (mediaType === 'FILE') resourceType = 'raw';

    const paramsToSign = {
      timestamp,
      folder: 'saas-pix-bot/products',
    };

    const signature = getSignature(paramsToSign, API_SECRET);

    const cloudinaryForm = new FormData();
    cloudinaryForm.append('file', new Blob([buffer]), file.name);
    cloudinaryForm.append('api_key', API_KEY);
    cloudinaryForm.append('timestamp', timestamp);
    cloudinaryForm.append('folder', 'saas-pix-bot/products');
    cloudinaryForm.append('signature', signature);

    const uploadRes = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/${resourceType}/upload`,
      {
        method: 'POST',
        body: cloudinaryForm,
      }
    );

    const data = await uploadRes.json();

    if (!uploadRes.ok) {
      return NextResponse.json(
        { error: data?.error?.message || 'Erro ao enviar para o Cloudinary.' },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      url: data.secure_url,
      publicId: data.public_id,
      resourceType: data.resource_type,
      originalFilename: data.original_filename,
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Falha interna no upload.' },
      { status: 500 }
    );
  }
}
