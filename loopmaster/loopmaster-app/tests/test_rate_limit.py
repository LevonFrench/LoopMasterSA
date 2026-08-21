from rate_limit import SlidingWindowRateLimiter


def test_retry_after_rounds_up_to_the_first_allowed_second():
    now = [0.0]
    limiter = SlidingWindowRateLimiter(1, 60.0, clock=lambda: now[0])

    assert limiter.allow("client") == (True, 0)

    now[0] = 58.1
    assert limiter.allow("client") == (False, 2)

    now[0] = 60.0
    assert limiter.allow("client") == (True, 0)


def test_periodic_cleanup_evicts_stale_identity_keys():
    now = [0.0]
    limiter = SlidingWindowRateLimiter(2, 60.0, clock=lambda: now[0])

    assert limiter.allow("stale-a") == (True, 0)
    assert limiter.allow("stale-b") == (True, 0)
    assert set(limiter._events) == {"stale-a", "stale-b"}

    now[0] = 61.0
    assert limiter.allow("current") == (True, 0)
    assert set(limiter._events) == {"current"}
