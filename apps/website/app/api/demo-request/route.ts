import { demoForm } from '@/content/forms';
import { handleSubmission } from '@/lib/submit';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  return handleSubmission(demoForm, req);
}
