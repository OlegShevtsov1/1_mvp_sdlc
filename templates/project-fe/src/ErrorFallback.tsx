export default function ErrorFallback({ reported }: { reported: boolean }) {
  return <p role="alert">{reported ? 'Something went wrong. The error was reported.' : 'Something went wrong.'}</p>
}
