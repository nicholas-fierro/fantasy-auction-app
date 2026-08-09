import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function toKebabCase(text: string): string {
  return text
    .replace(/[^a-zA-Z0-9\s]+/g, '')
    .toLowerCase()
    .split(/\s+/)
    .join('-');
}