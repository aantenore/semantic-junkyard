import type { ButtonHTMLAttributes, ReactNode } from "react";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
  label: string;
  active?: boolean;
}

export function IconButton({ icon, label, active, ...props }: IconButtonProps) {
  return (
    <button className={`icon-button ${active ? "is-active" : ""}`} title={label} aria-label={label} {...props}>
      {icon}
    </button>
  );
}
