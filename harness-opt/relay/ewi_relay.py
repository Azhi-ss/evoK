"""EWI-relay-v1. Separate from scripts/ewi_idle.py (mtime + assistant timestamps)."""

VERSION = "EWI-relay-v1"


def _bad_time(value) -> bool:
    if value is None or isinstance(value, bool) or not isinstance(value, (int, float)):
        return True
    if value != value or value == float("inf") or value == float("-inf"):
        return True
    return False


def ewi_relay_v1(*, t_first, t_last_write=None, response_ends=None, t_end=None, timed_out=None, threshold=600):
    """idle = t_end - max([t_first] + response ends after t_first).

    A missing, bool, string, or non-finite input returns 'EWI不可判' and never False.
    t_last_write is descriptive only and does not move t_first.
    """
    undecided = {"version": VERSION, "verdict": "EWI不可判", "ewi": None, "idle": None, "gap_max": None,
                 "last_write_idle": None, "last_write_gap_max": None}
    if response_ends is None or _bad_time(t_first) or _bad_time(t_end) or not isinstance(timed_out, bool):
        return undecided
    if any(_bad_time(item) for item in response_ends):
        return undecided
    after = [item for item in response_ends if item > t_first]
    points = [t_first, *sorted(after), t_end]
    idle = t_end - max([t_first, *after])
    gap_max = max(b - a for a, b in zip(points, points[1:]))
    last_idle = None
    last_gap = None
    if not _bad_time(t_last_write):
        last_points = [t_last_write, *sorted(item for item in response_ends if item > t_last_write), t_end]
        last_idle = t_end - max([t_last_write, *[item for item in response_ends if item > t_last_write]])
        last_gap = max(b - a for a, b in zip(last_points, last_points[1:]))
    clause1 = idle >= threshold
    clause2 = timed_out is True and gap_max >= threshold
    ewi = bool(clause1 or clause2)
    return {
        "version": VERSION,
        "verdict": ewi,
        "ewi": ewi,
        "idle": idle,
        "gap_max": gap_max,
        "clause1": clause1,
        "clause2": clause2,
        "last_write_idle": last_idle,
        "last_write_gap_max": last_gap,
    }
