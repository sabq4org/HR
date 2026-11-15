import { useEffect, useRef, useState } from 'react';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { useTheme, type ThemeChoice } from './theme';

const options: Array<{ value: ThemeChoice; label: string; Icon: typeof Sun }> = [
  { value: 'light', label: 'فاتح', Icon: Sun },
  { value: 'dark', label: 'داكن', Icon: Moon },
  { value: 'system', label: 'حسب الجهاز', Icon: Monitor },
];

/** The visible appearance switch: a button showing the current mode and a three-option menu. */
export function ThemeMenu({ className = '' }: { className?: string }) {
  const [choice, setChoice] = useTheme();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === choice) ?? options[2];
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        wrap.current?.querySelector<HTMLButtonElement>('.theme-trigger')?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    wrap.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  const moveFocus = (e: React.KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const items = [...(wrap.current?.querySelectorAll<HTMLButtonElement>('.theme-option') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? items.length - 1
          : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  return (
    <div className={`theme-menu ${className}`} ref={wrap}>
      <button
        type="button"
        className="icon-button theme-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`المظهر: ${current.label}`}
        title={`المظهر: ${current.label}`}
        onClick={() => setOpen((v) => !v)}
      >
        <current.Icon size={20} />
      </button>
      {open && (
        <div className="theme-popover" role="menu" aria-label="مظهر النظام" onKeyDown={moveFocus}>
          {options.map(({ value, label, Icon }) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={choice === value}
              className="theme-option"
              onClick={() => {
                setChoice(value);
                setOpen(false);
              }}
            >
              <Icon size={17} />
              <span>{label}</span>
              {choice === value && <Check size={16} className="theme-check" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
