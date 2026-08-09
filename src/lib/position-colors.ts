export type Position = 'QB' | 'RB' | 'WR' | 'TE' | 'K' | 'DST';
export type FlexPosition = 'Flex';
export type FilterPosition = Position | FlexPosition;

const POSITION_COLOR_MAP = {
  QB: {
    badgeClasses: 'bg-yellow-100 text-yellow-800 border-yellow-200 dark:bg-yellow-900/20 dark:text-yellow-400 dark:border-yellow-800',
    selectedBadgeClasses: 'bg-yellow-600 text-white border-yellow-600 dark:bg-yellow-500 dark:text-white dark:border-yellow-500',
    backgroundClasses: 'bg-yellow-100 dark:bg-yellow-900/20',
    gradientClasses: 'from-yellow-600 to-yellow-700',
    colorName: 'yellow',
  },
  RB: {
    badgeClasses: 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900/20 dark:text-green-400 dark:border-green-800',
    selectedBadgeClasses: 'bg-green-600 text-white border-green-600 dark:bg-green-500 dark:text-white dark:border-green-500',
    backgroundClasses: 'bg-green-100 dark:bg-green-900/20',
    gradientClasses: 'from-green-600 to-green-700',
    colorName: 'green',
  },
  WR: {
    badgeClasses: 'bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/20 dark:text-purple-400 dark:border-purple-800',
    selectedBadgeClasses: 'bg-purple-600 text-white border-purple-600 dark:bg-purple-500 dark:text-white dark:border-purple-500',
    backgroundClasses: 'bg-purple-100 dark:bg-purple-900/20',
    gradientClasses: 'from-purple-600 to-purple-700',
    colorName: 'purple',
  },
  TE: {
    badgeClasses: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/20 dark:text-red-400 dark:border-red-800',
    selectedBadgeClasses: 'bg-red-600 text-white border-red-600 dark:bg-red-500 dark:text-white dark:border-red-500',
    backgroundClasses: 'bg-red-100 dark:bg-red-900/20',
    gradientClasses: 'from-red-600 to-red-700',
    colorName: 'red',
  },
  K: {
    badgeClasses: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800',
    selectedBadgeClasses: 'bg-blue-600 text-white border-blue-600 dark:bg-blue-500 dark:text-white dark:border-blue-500',
    backgroundClasses: 'bg-blue-100 dark:bg-blue-900/20',
    gradientClasses: 'from-blue-600 to-blue-700',
    colorName: 'blue',
  },
  DST: {
    badgeClasses: 'bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/20 dark:text-orange-400 dark:border-orange-800',
    selectedBadgeClasses: 'bg-orange-600 text-white border-orange-600 dark:bg-orange-500 dark:text-white dark:border-orange-500',
    backgroundClasses: 'bg-orange-100 dark:bg-orange-900/20',
    gradientClasses: 'from-orange-600 to-orange-700',
    colorName: 'orange',
  },
  Flex: {
    badgeClasses: 'bg-indigo-100 text-indigo-800 border-indigo-200 dark:bg-indigo-900/20 dark:text-indigo-400 dark:border-indigo-800',
    selectedBadgeClasses: 'bg-indigo-600 text-white border-indigo-600 dark:bg-indigo-500 dark:text-white dark:border-indigo-500',
    backgroundClasses: 'bg-indigo-100 dark:bg-indigo-900/20',
    gradientClasses: 'from-indigo-600 to-indigo-700',
    colorName: 'indigo',
  },
} as const;

const DEFAULT_COLORS = {
  badgeClasses: 'bg-gray-100 text-gray-800 border-gray-200 dark:bg-gray-900/20 dark:text-gray-400 dark:border-gray-800',
  selectedBadgeClasses: 'bg-gray-600 text-white border-gray-600 dark:bg-gray-500 dark:text-white dark:border-gray-500',
  backgroundClasses: 'bg-gray-100 dark:bg-gray-900/20',
  gradientClasses: 'from-gray-600 to-gray-700',
  colorName: 'gray',
};

export function getPositionColors(position: FilterPosition) {
  return POSITION_COLOR_MAP[position] || DEFAULT_COLORS;
}

// Convenience functions for specific use cases
export function getPositionBadgeClasses(position: FilterPosition): string {
  return getPositionColors(position).badgeClasses;
}

export function getPositionBackgroundClasses(position: FilterPosition): string {
  return getPositionColors(position).backgroundClasses;
}

export function getPositionGradientClasses(position: FilterPosition): string {
  return getPositionColors(position).gradientClasses;
}

export function getPositionSelectedBadgeClasses(position: FilterPosition): string {
  return getPositionColors(position).selectedBadgeClasses;
}