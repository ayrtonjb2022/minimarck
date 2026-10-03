import { useState, useRef, useCallback } from "react";

export function useSubmitGuard() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const lockRef = useRef(false);

  const withGuard = useCallback(async (fn) => {
    if (lockRef.current) return; // ❌ Ya hay una operación en curso
    lockRef.current = true;
    setIsSubmitting(true);
    try {
      return await fn();
    } finally {
      lockRef.current = false;
      setIsSubmitting(false);
    }
  }, []);

  return { isSubmitting, withGuard };
}
