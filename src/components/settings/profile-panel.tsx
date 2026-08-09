'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Lock, LogOut } from 'lucide-react';
import { pb } from '@/lib/pb-client';
import { syncSession } from '@/server/actions/auth';
import { signOut } from '@/lib/session';
import { useUserTeamId } from '@/hooks/use-league';
import { useAllFantasyTeams } from '@/hooks/use-fantasy-teams';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function ProfilePanel() {
  const record = pb.authStore.record;
  const userTeamId = useUserTeamId();
  const { data: teams = [] } = useAllFantasyTeams();
  const myTeam = teams.find((team) => team.id === userTeamId);

  const [name, setName] = useState(record?.name ?? '');
  const [savingName, setSavingName] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [savingPassword, setSavingPassword] = useState(false);

  const handleSaveName = async () => {
    const userId = record?.id;
    if (!userId) return;
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error('Display name cannot be empty.');
      return;
    }
    setSavingName(true);
    try {
      await pb.collection('users').update(userId, { name: trimmed });
      // Mirror the updated name into the httpOnly cookie the server reads. The
      // token is unchanged (only a password change rotates it).
      await syncSession(pb.authStore.token, {
        id: userId,
        email: record?.email ?? '',
        name: trimmed,
      });
      toast.success('Display name updated');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update display name');
    } finally {
      setSavingName(false);
    }
  };

  // Password rules mirror the retired ProfileModal.
  const validatePassword = (): string | null => {
    if (!currentPassword || !newPassword || !confirmPassword) {
      return 'Fill in all password fields.';
    }
    if (newPassword.length < 8) {
      return 'New password must be at least 8 characters.';
    }
    if (newPassword !== confirmPassword) {
      return 'New password and confirmation do not match.';
    }
    if (newPassword === currentPassword) {
      return 'New password must be different from your current password.';
    }
    return null;
  };

  const handleSubmitPassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setPasswordError(null);

    const validationError = validatePassword();
    if (validationError) {
      setPasswordError(validationError);
      return;
    }

    const userId = record?.id;
    const userEmail = record?.email;
    if (!userId || !userEmail) {
      setPasswordError('You must be signed in to change your password.');
      return;
    }

    setSavingPassword(true);
    try {
      // Changing the password requires the current password (validated by PB)
      // and rotates the auth token, so re-authenticate immediately to keep the
      // session alive.
      await pb.collection('users').update(userId, {
        oldPassword: currentPassword,
        password: newPassword,
        passwordConfirm: confirmPassword,
      });

      const authData = await pb.collection('users').authWithPassword(userEmail, newPassword);
      await syncSession(authData.token, {
        id: authData.record.id,
        email: authData.record.email,
        name: authData.record.name || '',
      });

      toast.success('Password updated');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      const message = err instanceof Error ? err.message : undefined;
      toast.error(message || 'Could not update password — check your current password');
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <div className="flex flex-col gap-5 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>Your display name and the email you sign in with.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-4">
            <div className="flex-1 min-w-[200px] flex flex-col gap-2">
              <Label htmlFor="display-name">Display name</Label>
              <Input
                id="display-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="flex-1 min-w-[200px] flex flex-col gap-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" value={record?.email ?? ''} readOnly disabled />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label>My team</Label>
            <div className="flex h-9 items-center justify-between rounded-md border bg-muted/40 px-3 text-sm">
              <span className={myTeam ? '' : 'text-muted-foreground'}>
                {myTeam?.name ?? 'No team'}
              </span>
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Lock className="h-3 w-3" />
                Locked
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Team assignments are managed by your commissioner.
            </p>
          </div>
          <div className="flex justify-end">
            <Button onClick={handleSaveName} disabled={savingName} className="max-md:h-11 max-md:w-full">
              {savingName ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Password</CardTitle>
          <CardDescription>
            Change your account password. You&apos;ll stay signed in on this device.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmitPassword} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="current-password">Current password</Label>
              <Input
                id="current-password"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>
            <div className="flex flex-wrap gap-4">
              <div className="flex-1 min-w-[200px] flex flex-col gap-2">
                <Label htmlFor="new-password">New password</Label>
                <Input
                  id="new-password"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
              <div className="flex-1 min-w-[200px] flex flex-col gap-2">
                <Label htmlFor="confirm-password">Confirm new password</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
            </div>
            {passwordError && (
              <p className="text-sm text-red-600 dark:text-red-400">{passwordError}</p>
            )}
            <div className="flex justify-end">
              <Button type="submit" disabled={savingPassword} className="max-md:h-11 max-md:w-full">
                {savingPassword ? 'Updating…' : 'Update password'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex items-center justify-between gap-4 max-md:flex-col max-md:items-stretch">
          <div>
            <div className="font-semibold">Session</div>
            <div className="text-sm text-muted-foreground">
              Sign out of the draft helper on this device.
            </div>
          </div>
          <Button
            variant="outline"
            onClick={signOut}
            className="text-red-600 border-red-200 hover:text-red-700 dark:text-red-400 dark:border-red-900 max-md:h-11 max-md:w-full"
          >
            <LogOut className="h-4 w-4 mr-2" />
            Sign out
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
