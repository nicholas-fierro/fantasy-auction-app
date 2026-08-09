'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { pb } from '@/lib/pb-client';
import { getInviteInfo, signupWithInvite, type InviteInfoResult } from '@/server/actions/signup';
import { syncSession } from '@/server/actions/auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// Invite-based signup (docs/multi-user-plan.md): the account is created by the
// signupWithInvite server action (public REST signup stays closed per AD-2),
// then the client logs in through the exact same authWithPassword +
// syncSession path the login page uses.

function SignupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [invite, setInvite] = useState<InviteInfoResult | null>(null);

  // Preview the invite so the user can confirm they're joining the right league
  // (and see an invalid/expired token before filling out the form).
  useEffect(() => {
    if (!token) return;
    let active = true;
    getInviteInfo(token)
      .then(result => { if (active) setInvite(result); })
      .catch(() => { if (active) setInvite({ ok: false, error: 'Could not verify this invite' }); });
    return () => { active = false; };
  }, [token]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setIsSubmitting(true);

    try {
      const result = await signupWithInvite({ token, email, password, name });
      if (!result.ok) {
        setError(result.error ?? 'Signup failed');
        setIsSubmitting(false);
        return;
      }

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
      setError('Account created, but sign-in failed — try logging in.');
      setIsSubmitting(false);
    }
  };

  if (!token) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">Invite required</CardTitle>
          <CardDescription>
            Accounts are created by invitation. Ask your league&apos;s commissioner
            for an invite link.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  // A resolved-but-invalid invite (bad token, used, or expired) is a dead end —
  // show the reason instead of a form that can't succeed.
  if (invite && !invite.ok) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">Invite unavailable</CardTitle>
          <CardDescription>{invite.error ?? 'This invite link is not valid.'}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Ask your league&apos;s commissioner for a fresh invite link.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="text-2xl">Join your league</CardTitle>
        <CardDescription>
          {invite?.ok && invite.leagueName ? (
            <>
              You&apos;re joining <strong>{invite.leagueName}</strong>
              {invite.teamName ? <> as <strong>{invite.teamName}</strong></> : null}.
            </>
          ) : (
            'Create your account to claim your team'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
            />
          </div>
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
            {invite?.ok && invite.emailLocked && (
              <p className="text-xs text-muted-foreground">
                This invite is tied to a specific email address — use the one it was sent to.
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              required
              minLength={8}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm">Confirm password</Label>
            <Input
              id="confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
              minLength={8}
            />
          </div>
          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
          <Button type="submit" className="w-full max-md:h-11" disabled={isSubmitting}>
            {isSubmitting ? 'Creating account…' : 'Create account'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export default function SignupPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-gray-50 dark:bg-gray-900 p-4 sm:p-6">
      {/* useSearchParams requires a Suspense boundary during prerender */}
      <Suspense fallback={null}>
        <SignupForm />
      </Suspense>
    </div>
  );
}
