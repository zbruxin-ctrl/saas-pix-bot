// prisma/seed.ts — seed seguro sem senha hardcoded
import { PrismaClient, AdminRole } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;

  if (!adminPassword || adminPassword.length < 12) {
    throw new Error(
      'Defina SEED_ADMIN_PASSWORD no .env com pelo menos 12 caracteres antes de executar o seed.'
    );
  }

  const passwordHash = await bcrypt.hash(adminPassword, 12);

  const admin = await prisma.adminUser.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      passwordHash,
      name: 'Admin Principal',
      role: AdminRole.SUPERADMIN,
      isActive: true,
    },
  });

  console.log(`Admin seed criado/verificado: ${admin.email} (${admin.role})`);

  // Produto de exemplo
  const product = await prisma.product.upsert({
    where: { id: 'seed-product-01' },
    update: {},
    create: {
      id: 'seed-product-01',
      name: 'Produto Exemplo',
      description: 'Produto criado pelo seed para testes.',
      price: 29.9,
      deliveryType: 'TEXT',
      deliveryContent: 'Obrigado pela compra! Este é o conteúdo do produto.',
      isActive: true,
      stock: null,
    },
  });

  console.log(`Produto seed criado/verificado: ${product.name}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
