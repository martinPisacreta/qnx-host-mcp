#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/neutrino.h>
#include <time.h>

static void report_error(const char *call)
{
    const int saved_errno = errno;
    fprintf(stderr, "%s: %s\n", call, strerror(saved_errno));
}

int main(void)
{
    const int pulse_value = 42;
    int chid = -1;
    int coid = -1;
    int timer_created = 0;
    int received = 0;
    int elapsed_ok = 0;
    int result = EXIT_FAILURE;
    timer_t timer_id = (timer_t)0;
    struct sigevent ev = {0};
    struct itimerspec period = {0};
    struct timespec start = {0};
    struct timespec end = {0};
    double elapsed_ms;

    chid = ChannelCreate(0);
    if (chid == -1) {
        report_error("ChannelCreate");
        goto cleanup;
    }
    coid = ConnectAttach(0, 0, chid, _NTO_SIDE_CHANNEL, 0);
    if (coid == -1) {
        report_error("ConnectAttach");
        goto cleanup;
    }
    SIGEV_PULSE_INIT(&ev, coid, SIGEV_PULSE_PRIO_INHERIT,
                     _PULSE_CODE_MINAVAIL, pulse_value);
    if (timer_create(CLOCK_MONOTONIC, &ev, &timer_id) == -1) {
        report_error("timer_create");
        goto cleanup;
    }
    timer_created = 1;
    period.it_value.tv_nsec = 100000000L;
    period.it_interval.tv_nsec = 100000000L;
    if (clock_gettime(CLOCK_MONOTONIC, &start) == -1) {
        report_error("clock_gettime");
        goto cleanup;
    }
    if (timer_settime(timer_id, 0, &period, NULL) == -1) {
        report_error("timer_settime");
        goto cleanup;
    }
    while (received < 5) {
        struct _pulse pulse = {0};
        if (MsgReceivePulse(chid, &pulse, sizeof(pulse), NULL) == -1) {
            report_error("MsgReceivePulse");
            goto cleanup;
        }
        if (pulse.code != _PULSE_CODE_MINAVAIL ||
            pulse.value.sival_int != pulse_value) {
            errno = EPROTO;
            report_error("MsgReceivePulse (unexpected code or value)");
            goto cleanup;
        }
        ++received;
    }
    if (clock_gettime(CLOCK_MONOTONIC, &end) == -1) {
        report_error("clock_gettime");
        goto cleanup;
    }
    elapsed_ms = (double)(end.tv_sec - start.tv_sec) * 1000.0 +
                 (double)(end.tv_nsec - start.tv_nsec) / 1000000.0;
    elapsed_ok = elapsed_ms >= 400.0 && elapsed_ms <= 1500.0;
    result = EXIT_SUCCESS;

cleanup:
    if (timer_created && timer_delete(timer_id) == -1) {
        report_error("timer_delete");
        result = EXIT_FAILURE;
    }
    if (coid != -1 && ConnectDetach(coid) == -1) {
        report_error("ConnectDetach");
        result = EXIT_FAILURE;
    }
    if (chid != -1 && ChannelDestroy(chid) == -1) {
        report_error("ChannelDestroy");
        result = EXIT_FAILURE;
    }
    if (result != EXIT_SUCCESS) {
        return EXIT_FAILURE;
    }
    printf("QNX_PULSES_OK received=%d\n", received);
    printf("elapsed_ms_ok=%d\n", elapsed_ok);
    return elapsed_ok ? EXIT_SUCCESS : EXIT_FAILURE;
}
