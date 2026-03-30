import random
import time
from datetime import datetime, timezone
from typing import Callable, TypeVar


T = TypeVar("T")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def log(message: str) -> None:
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {message}", flush=True)


def pick_random_title(titles: list[str], fallback: str) -> str:
    clean = [title.strip() for title in titles if title and title.strip()]
    if clean:
        return random.choice(clean)
    return fallback


def retry(
    fn: Callable[[], T],
    *,
    attempts: int,
    backoff_sec: int,
    on_retry: Callable[[int, Exception], None] | None = None,
) -> T:
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except Exception as error:  # noqa: BLE001
            last_error = error
            if attempt >= attempts:
                break
            if on_retry:
                on_retry(attempt, error)
            time.sleep(backoff_sec * attempt)
    if last_error is None:
        raise RuntimeError("Retry failed with no captured error.")
    raise last_error
