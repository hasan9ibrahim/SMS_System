// The Xpert logo (team trial round 9: the platform's brand, §15). The artwork is SVG files in assets/brand, redrawn
// as vectors from the brand sheet (masters in docs/design/brand). Each logo comes in two versions: navy lettering for
// light backgrounds and white lettering with brighter blues for dark ones; CSS shows the one that suits the theme
// (styles/brand.css).
import logo from "../assets/brand/xpert-logo.svg";
import logoWhite from "../assets/brand/xpert-logo-white.svg";
import mark from "../assets/brand/xpert-mark.svg";
import markWhite from "../assets/brand/xpert-mark-white.svg";

const FILES = { logo: [logo, logoWhite], mark: [mark, markWhite] } as const;

/** `logo` is the X with "pert"; `mark` is the X alone. `height` in px; the width follows the artwork. */
export function BrandLogo({
  variant = "logo",
  height,
  className,
}: {
  variant?: keyof typeof FILES;
  height: number;
  className?: string;
}) {
  const [onLight, onDark] = FILES[variant];
  return (
    <span className={`brand-logo${className ? ` ${className}` : ""}`} style={{ height }}>
      <img className="brand-on-light" src={onLight} alt="Xpert" draggable={false} />
      <img className="brand-on-dark" src={onDark} alt="Xpert" draggable={false} />
    </span>
  );
}
