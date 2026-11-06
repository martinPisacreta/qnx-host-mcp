/* QNX SDP 8.0 resource-manager example. Compiled with qcc and run on QNX 8.0 in QEMU on 2026-11-06;
 * see evidence/qemu-run-resmgr-20261106. References:
 * https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/r/resmgr_attach.html
 * https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/i/iofunc_read_verify.html
 * https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/d/dispatch_block.html
 * https://www.qnx.com/developers/docs/8.0/com.qnx.doc.neutrino.lib_ref/topic/d/dispatch_handler.html
 */
#include <sys/iofunc.h>
#include <sys/resmgr.h>
#include <sys/dispatch.h>
#include <sys/stat.h>
#include <sys/uio.h>
#include <pthread.h>
#include <stdatomic.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static const char device_path[] = "/dev/automata-echo";
static const char message[] = "hello from a QNX resource manager";
static atomic_int ready = ATOMIC_VAR_INIT(0);

static void fail(const char *call, int error)
{
    fprintf(stderr, "resmgr: %s failed: errno=%d (%s)\n",
            call, error, strerror(error));
    /* Terminate both threads, including any blocked client. */
    exit(EXIT_FAILURE);
}

static int io_read(resmgr_context_t *ctp, io_read_t *msg,
                   iofunc_ocb_t *ocb)
{
    const size_t length = sizeof(message) - 1;
    size_t count;
    size_t requested;
    size_t offset;
    int status;

    status = iofunc_read_verify(ctp, msg, ocb, NULL);
    if (status != EOK) {
        fail("iofunc_read_verify", status);
    }
    /* This demonstration supports ordinary read(), not extended reads. */
    if ((msg->i.xtype & _IO_XTYPE_MASK) != _IO_XTYPE_NONE) {
        fail("io_read (unsupported xtype)", ENOSYS);
    }
    if (ocb->offset < 0) {
        fail("io_read (negative offset)", EINVAL);
    }

    requested = _IO_READ_GET_NBYTES(msg);
    if (requested == 0 || ocb->offset >= (off_t)length) {
        _IO_SET_READ_NBYTES(ctp, 0);
        return _RESMGR_NPARTS(0);
    }
    offset = (size_t)ocb->offset;
    count = length - offset;
    if (count > requested) {
        count = requested;
    }
    SETIOV(ctp->iov, (void *)(message + offset), count);
    _IO_SET_READ_NBYTES(ctp, count);
    ocb->offset += (off_t)count;
    ocb->attr->flags |= IOFUNC_ATTR_ATIME;
    return _RESMGR_NPARTS(1);
}

static void *serve(void *argument)
{
    dispatch_t *dispatch;
    dispatch_context_t *context;
    dispatch_context_t *next;
    resmgr_attr_t resource_attributes = {0};
    resmgr_connect_funcs_t connect_functions;
    resmgr_io_funcs_t io_functions;
    iofunc_attr_t attributes;

    (void)argument;
    dispatch = dispatch_create();
    if (dispatch == NULL) {
        fail("dispatch_create", errno);
    }
    resource_attributes.nparts_max = 1;
    resource_attributes.msg_max_size = 2048;
    iofunc_func_init(_RESMGR_CONNECT_NFUNCS, &connect_functions,
                     _RESMGR_IO_NFUNCS, &io_functions);
    io_functions.read = io_read;
    iofunc_attr_init(&attributes, S_IFCHR | 0444, NULL, NULL);
    attributes.nbytes = sizeof(message) - 1;

    if (resmgr_attach(dispatch, &resource_attributes, device_path,
                      _FTYPE_ANY, _RESMGR_FLAG_SELF, &connect_functions,
                      &io_functions, &attributes) == -1) {
        fail("resmgr_attach", errno);
    }
    context = dispatch_context_alloc(dispatch);
    if (context == NULL) {
        fail("dispatch_context_alloc", errno);
    }
    atomic_store_explicit(&ready, 1, memory_order_release);

    for (;;) {
        next = dispatch_block(context);
        if (next == NULL) {
            fail("dispatch_block", errno);
        }
        context = next;
        /* The documented failure return does not guarantee an errno value. */
        errno = 0;
        if (dispatch_handler(context) == -1) {
            fail("dispatch_handler", errno != 0 ? errno : EIO);
        }
    }
    return NULL;
}

int main(void)
{
    pthread_t server;
    struct stat information;
    const struct timespec pause = {0, 10000000L};
    char buffer[sizeof(message) + 1];
    size_t total = 0;
    int registered = 0;
    int descriptor;
    int error;
    int attempt;

    error = pthread_create(&server, NULL, serve, NULL);
    if (error != 0) {
        fail("pthread_create", error);
    }
    /* At most 500 polling intervals; ENOENT means registration is pending. */
    for (attempt = 0; attempt < 500; ++attempt) {
        if (atomic_load_explicit(&ready, memory_order_acquire)) {
            if (stat(device_path, &information) == 0) {
                registered = 1;
                break;
            }
            if (errno != ENOENT) {
                fail("stat", errno);
            }
        }
        if (nanosleep(&pause, NULL) == -1) {
            fail("nanosleep", errno);
        }
    }
    if (!registered) {
        fail("wait for /dev/automata-echo", ETIMEDOUT);
    }
    descriptor = open(device_path, O_RDONLY);
    if (descriptor == -1) {
        fail("open", errno);
    }

    for (;;) {
        size_t capacity = sizeof(buffer) - 1 - total;
        size_t request = capacity < 7 ? capacity : 7;
        ssize_t received;

        if (request == 0) {
            fail("read (unexpected extra data)", EOVERFLOW);
        }
        received = read(descriptor, buffer + total, request);
        if (received == -1) {
            fail("read", errno);
        }
        if (received == 0) {
            break;
        }
        if ((size_t)received > request) {
            fail("read (invalid byte count)", EPROTO);
        }
        total += (size_t)received;
    }
    buffer[total] = '\0';
    if (total != sizeof(message) - 1 ||
        memcmp(buffer, message, sizeof(message) - 1) != 0) {
        fail("read (unexpected content)", EPROTO);
    }
    if (close(descriptor) == -1) {
        fail("close", errno);
    }
    if (printf("resmgr: read %zu bytes: %s\n", total, buffer) < 0) {
        fail("printf", errno);
    }
    if (puts("resmgr: ok") == EOF) {
        fail("puts", errno);
    }
    if (fflush(stdout) == EOF) {
        fail("fflush", errno);
    }
    /* Returning from main terminates the server thread and removes its path. */
    return EXIT_SUCCESS;
}
