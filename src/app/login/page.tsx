'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { pb } from '@/lib/pb-client';
import { syncSession } from '@/server/actions/auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      // Authenticate directly against PocketBase in the browser; the token lands
      // in pb.authStore (localStorage). Then mirror it into the httpOnly pb_auth
      // cookie so the middleware + server-side import pipeline stay authenticated.
      const authData = await pb.collection('users').authWithPassword(email, password);
      await syncSession(authData.token, {
        id: authData.record.id,
        email: authData.record.email,
        name: authData.record.name || '',
      });
      router.push('/');
      router.refresh();
    } catch {
      pb.authStore.clear();
      setError('Invalid email or password');
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-gray-50 dark:bg-gray-900 p-4 sm:p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">Fantasy Football Draft Helper</CardTitle>
          <CardDescription>Sign in to run your mock drafts</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </div>
            {error && (
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            )}
            <Button type="submit" className="w-full max-md:h-11" disabled={isSubmitting}>
              {isSubmitting ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
