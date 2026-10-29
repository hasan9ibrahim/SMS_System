// A QR code as an SVG (team trial round 9: authenticator enrolment, §13.28). Always dark on white, also in the dark
// theme, as phone cameras read it best that way.
import { useMemo } from "react";
import qrcode from "qrcode-generator";

export function QrCode({ value, size = 180, label }: { value: string; size?: number; label: string }) {
  const { count, path } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c},${r}h1v1h-1z`;
    return { count: n, path: d };
  }, [value]);
  const quiet = 4; // the margin the standard asks for
  const box = count + quiet * 2;
  return (
    <svg
      className="qr-code"
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`${-quiet} ${-quiet} ${box} ${box}`}
      shapeRendering="crispEdges"
    >
      <rect x={-quiet} y={-quiet} width={box} height={box} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
