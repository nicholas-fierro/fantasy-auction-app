'use client';

import { cn } from '@/lib/utils';
import { useIsDraftRoom, useNavigation } from '@/contexts/navigation-context';
import { navigationItems } from '@/components/top-navbar';

// Phone-only bottom tab bar — the counterpart to the desktop nav tabs in
// TierOneBar, which are hidden below `md`. It's a flex sibling of the scroll
// area (see AppShell) rather than `position: fixed`, so content can never end
// up underneath it.
export function MobileTabBar() {
  const { currentView, setCurrentView } = useNavigation();
  const isDraftRoom = useIsDraftRoom();

  // Same rule as the desktop tabs: draft chrome only inside the draft room.
  if (!isDraftRoom) return null;

  return (
    // z-50: above the nomination ticker's scrim, so the tabs stay usable while
    // the ticker sheet is open.
    <nav className="relative z-50 shrink-0 border-t border-gray-200 bg-white pb-[env(safe-area-inset-bottom)] dark:border-gray-800 dark:bg-gray-900 md:hidden">
      <div className="flex h-14 items-stretch">
        {navigationItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentView === item.id;
          return (
            <button
              key={item.id}
              onClick={() => setCurrentView(item.id)}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-semibold transition-colors',
                isActive
                  ? 'text-blue-700 dark:text-blue-400'
                  : 'text-gray-500 dark:text-gray-400'
              )}
            >
              <Icon className="h-[21px] w-[21px]" />
              <span className="max-w-full truncate px-1">{item.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
