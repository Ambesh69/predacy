import Image from "next/image";

export default function BrandMark({ size = 40 }: { size?: number }) {
  return (
    <Image
      src="/predacy-logo.png"
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className="shrink-0"
      priority
    />
  );
}
