#define _GNU_SOURCE

#include <pipewire/pipewire.h>
#include <spa/param/video/format-utils.h>
#include <spa/param/props.h>
#include <spa/utils/result.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <time.h>
#include <poll.h>
#include <sys/uio.h>
#include <signal.h>
#include <turbojpeg.h>

#define WSTN_MAGIC 0x5753544EU

struct __attribute__((packed)) wstn_frame_header {
	uint32_t magic;         /* 0x5753544E ("WSTN") */
	uint32_t width;
	uint32_t height;
	uint32_t stride;
	uint32_t format;        /* enum spa_video_format */
	uint64_t timestamp_us;
};

struct stream_capture_data {
	struct pw_main_loop *loop;
	struct pw_context *context;
	struct pw_core *core;
	struct pw_stream *stream;
	struct spa_hook stream_listener;
	tjhandle tj;
	int jpeg_quality;

	const char *target_node;
	int out_fd;
	bool close_out_fd;

	uint32_t width;
	uint32_t height;
	uint32_t stride;
	uint32_t format;
	bool format_set;

	uint64_t total_frames;
	uint64_t dropped_frames;
};

static struct pw_main_loop *g_main_loop = NULL;

static void handle_signal(int sig)
{
	(void)sig;
	if (g_main_loop)
		pw_main_loop_quit(g_main_loop);
}

static void on_stream_state_changed(void *userdata, enum pw_stream_state old,
                                    enum pw_stream_state state, const char *error)
{
	struct stream_capture_data *data = (struct stream_capture_data *)userdata;
	(void)old;

	fprintf(stderr, "[pw_stream] state: %s -> %s\n",
	        pw_stream_state_as_string(old),
	        pw_stream_state_as_string(state));

	if (state == PW_STREAM_STATE_ERROR) {
		fprintf(stderr, "[pw_stream] stream error: %s\n", error ? error : "unknown");
		if (data->loop)
			pw_main_loop_quit(data->loop);
	}
}

static void on_stream_param_changed(void *userdata, uint32_t id, const struct spa_pod *param)
{
	struct stream_capture_data *data = (struct stream_capture_data *)userdata;

	if (param == NULL || id != SPA_PARAM_Format)
		return;

	struct spa_video_info_raw info;
	if (spa_format_video_raw_parse(param, &info) < 0) {
		fprintf(stderr, "[pw_stream] Failed to parse raw video format\n");
		return;
	}

	data->width = info.size.width;
	data->height = info.size.height;
	data->format = info.format;
	data->stride = info.size.width * 4;
	data->format_set = true;

	fprintf(stderr, "[pw_stream] Negotiated format: %ux%u format=%u\n",
	        data->width, data->height, data->format);

	uint8_t buffer[1024];
	struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, sizeof(buffer));
	const struct spa_pod *params[2];

	params[0] = spa_pod_builder_add_object(&b,
	    SPA_TYPE_OBJECT_ParamBuffers, SPA_PARAM_Buffers,
	    SPA_PARAM_BUFFERS_buffers, SPA_POD_CHOICE_RANGE_Int(4, 2, 16),
	    SPA_PARAM_BUFFERS_blocks, SPA_POD_Int(1),
	    SPA_PARAM_BUFFERS_size, SPA_POD_Int(data->width * data->height * 4),
	    SPA_PARAM_BUFFERS_stride, SPA_POD_Int(data->width * 4),
	    SPA_PARAM_BUFFERS_dataType, SPA_POD_CHOICE_FLAGS_Int((1 << SPA_DATA_MemPtr) | (1 << SPA_DATA_MemFd)));

	params[1] = spa_pod_builder_add_object(&b,
	    SPA_TYPE_OBJECT_ParamMeta, SPA_PARAM_Meta,
	    SPA_PARAM_META_type, SPA_POD_Id(SPA_META_Header),
	    SPA_PARAM_META_size, SPA_POD_Int(sizeof(struct spa_meta_header)));

	pw_stream_update_params(data->stream, params, 2);
}

static void on_stream_process(void *userdata)
{
	struct stream_capture_data *data = (struct stream_capture_data *)userdata;
	struct pw_buffer *b = pw_stream_dequeue_buffer(data->stream);
	if (!b)
		return;

	struct spa_buffer *buf = b->buffer;
	if (buf->n_datas == 0 || !buf->datas[0].data) {
		pw_stream_queue_buffer(data->stream, b);
		return;
	}

	struct spa_data *d = &buf->datas[0];
	uint32_t width = data->width;
	uint32_t height = data->height;
	if (width == 0 || height == 0) {
		pw_stream_queue_buffer(data->stream, b);
		return;
	}

	uint32_t stride = d->chunk->stride > 0 ? (uint32_t)d->chunk->stride : (width * 4);
	const uint8_t *pixel_data = (const uint8_t *)d->data + d->chunk->offset;

	if (data->tj && pixel_data) {
		unsigned char *jpeg_buf = NULL;
		unsigned long jpeg_size = 0;
		int pixel_fmt = TJPF_BGRX;
		if (data->format == SPA_VIDEO_FORMAT_RGBx || data->format == SPA_VIDEO_FORMAT_RGBA) {
			pixel_fmt = TJPF_RGBX;
		}

		int q = data->jpeg_quality > 0 ? data->jpeg_quality : 80;
		int res = tjCompress2(data->tj, pixel_data, (int)width, (int)stride, (int)height,
		                      pixel_fmt, &jpeg_buf, &jpeg_size,
		                      TJSAMP_420, q, TJFLAG_FASTDCT);

		if (res == 0 && jpeg_buf != NULL && jpeg_size > 0) {
			struct pollfd pfd = { .fd = data->out_fd, .events = POLLOUT, .revents = 0 };
			if (poll(&pfd, 1, 0) > 0 && (pfd.revents & POLLOUT)) {
				ssize_t written = write(data->out_fd, jpeg_buf, (size_t)jpeg_size);
				if (written > 0 && (size_t)written == jpeg_size) {
					data->total_frames++;
				} else {
					data->dropped_frames++;
				}
			} else {
				data->dropped_frames++;
			}
			tjFree(jpeg_buf);
		}
	}

	pw_stream_queue_buffer(data->stream, b);
}

static const struct pw_stream_events stream_events = {
	PW_VERSION_STREAM_EVENTS,
	.state_changed = on_stream_state_changed,
	.param_changed = on_stream_param_changed,
	.process = on_stream_process,
};

static void print_usage(const char *progname)
{
	fprintf(stderr,
	        "Usage: %s [OPTIONS] [NODE_NAME]\n"
	        "\n"
	        "PipeWire video frame grabber for wstn-cua.\n"
	        "\n"
	        "Options:\n"
	        "  -n, --node <name>    Target PipeWire node name (default: 'weston.pipewire')\n"
	        "  -o, --out <path>     Output pipe or file path (default: stdout)\n"
	        "  -w, --width <pixels> Preferred width (default: any)\n"
	        "  -h, --height <pixels> Preferred height (default: any)\n"
	        "  -f, --fps <fps>      Preferred framerate (default: any)\n"
	        "  --help               Show this help message\n",
	        progname);
}

int main(int argc, char *argv[])
{
	struct stream_capture_data data;
	memset(&data, 0, sizeof(data));
	data.out_fd = STDOUT_FILENO;

	const char *node_name = NULL;
	const char *out_path = NULL;
	uint32_t req_width = 0;
	uint32_t req_height = 0;
	uint32_t req_fps = 0;
	int quality = 80;

	for (int i = 1; i < argc; i++) {
		if (strcmp(argv[i], "--help") == 0) {
			print_usage(argv[0]);
			return 0;
		} else if ((strcmp(argv[i], "--node") == 0 || strcmp(argv[i], "-n") == 0) && i + 1 < argc) {
			node_name = argv[++i];
		} else if ((strcmp(argv[i], "--out") == 0 || strcmp(argv[i], "-o") == 0) && i + 1 < argc) {
			out_path = argv[++i];
		} else if (strcmp(argv[i], "--width") == 0 && i + 1 < argc) {
			req_width = (uint32_t)strtoul(argv[++i], NULL, 10);
		} else if (strcmp(argv[i], "--height") == 0 && i + 1 < argc) {
			req_height = (uint32_t)strtoul(argv[++i], NULL, 10);
		} else if (strcmp(argv[i], "--fps") == 0 && i + 1 < argc) {
			req_fps = (uint32_t)strtoul(argv[++i], NULL, 10);
		} else if (strcmp(argv[i], "--quality") == 0 && i + 1 < argc) {
			quality = (int)strtoul(argv[++i], NULL, 10);
		} else if (argv[i][0] != '-') {
			if (!node_name)
				node_name = argv[i];
		}
	}

	data.tj = tjInitCompress();
	data.jpeg_quality = quality > 0 ? quality : 80;

	if (!node_name) {
		node_name = getenv("PIPEWIRE_NODE_NAME");
	}
	if (!node_name) {
		node_name = "weston.pipewire";
	}
	data.target_node = node_name;

	if (out_path) {
		int fd = open(out_path, O_WRONLY | O_CREAT | O_NONBLOCK, 0644);
		if (fd < 0) {
			fprintf(stderr, "[pw_stream] Failed to open output path %s: %s\n", out_path, strerror(errno));
			return 1;
		}
		data.out_fd = fd;
		data.close_out_fd = true;
	} else {
		/* Attempt to enlarge pipe buffer on stdout if it is a pipe */
		#ifdef F_SETPIPE_SZ
		(void)fcntl(STDOUT_FILENO, F_SETPIPE_SZ, 4 * 1024 * 1024);
		#endif
		int flags = fcntl(STDOUT_FILENO, F_GETFL, 0);
		if (flags >= 0) {
			(void)fcntl(STDOUT_FILENO, F_SETFL, flags | O_NONBLOCK);
		}
	}

	pw_init(&argc, &argv);

	data.loop = pw_main_loop_new(NULL);
	if (!data.loop) {
		fprintf(stderr, "[pw_stream] Failed to create PipeWire main loop\n");
		if (data.close_out_fd) close(data.out_fd);
		return 1;
	}
	g_main_loop = data.loop;

	struct sigaction sa;
	memset(&sa, 0, sizeof(sa));
	sa.sa_handler = handle_signal;
	sigaction(SIGINT, &sa, NULL);
	sigaction(SIGTERM, &sa, NULL);

	data.context = pw_context_new(pw_main_loop_get_loop(data.loop), NULL, 0);
	if (!data.context) {
		fprintf(stderr, "[pw_stream] Failed to create PipeWire context\n");
		pw_main_loop_destroy(data.loop);
		if (data.close_out_fd) close(data.out_fd);
		return 1;
	}

	data.core = pw_context_connect(data.context, NULL, 0);
	if (!data.core) {
		fprintf(stderr, "[pw_stream] Failed to connect to PipeWire core\n");
		pw_context_destroy(data.context);
		pw_main_loop_destroy(data.loop);
		if (data.close_out_fd) close(data.out_fd);
		return 1;
	}

	struct pw_properties *props = pw_properties_new(
		PW_KEY_MEDIA_TYPE, "Video",
		PW_KEY_MEDIA_CATEGORY, "Capture",
		PW_KEY_MEDIA_ROLE, "Screen",
		PW_KEY_TARGET_OBJECT, data.target_node,
		NULL
	);

	data.stream = pw_stream_new_simple(
		pw_main_loop_get_loop(data.loop),
		"wstn-pw-capture",
		props,
		&stream_events,
		&data
	);

	if (!data.stream) {
		fprintf(stderr, "[pw_stream] Failed to create pw_stream\n");
		pw_core_disconnect(data.core);
		pw_context_destroy(data.context);
		pw_main_loop_destroy(data.loop);
		if (data.close_out_fd) close(data.out_fd);
		return 1;
	}

	uint8_t buffer[2048];
	struct spa_pod_builder b = SPA_POD_BUILDER_INIT(buffer, sizeof(buffer));
	const struct spa_pod *params[1];

	uint32_t width_def = req_width > 0 ? req_width : 1280;
	uint32_t height_def = req_height > 0 ? req_height : 720;
	uint32_t fps_val = req_fps > 0 ? req_fps : 60;

	params[0] = spa_pod_builder_add_object(&b,
		SPA_TYPE_OBJECT_Format, SPA_PARAM_EnumFormat,
		SPA_FORMAT_mediaType, SPA_POD_Id(SPA_MEDIA_TYPE_video),
		SPA_FORMAT_mediaSubtype, SPA_POD_Id(SPA_MEDIA_SUBTYPE_raw),
		SPA_FORMAT_VIDEO_format, SPA_POD_CHOICE_ENUM_Id(7,
			SPA_VIDEO_FORMAT_RGBx,
			SPA_VIDEO_FORMAT_RGBx,
			SPA_VIDEO_FORMAT_BGRx,
			SPA_VIDEO_FORMAT_RGBA,
			SPA_VIDEO_FORMAT_BGRA,
			SPA_VIDEO_FORMAT_xRGB,
			SPA_VIDEO_FORMAT_xBGR),
		SPA_FORMAT_VIDEO_size, SPA_POD_CHOICE_RANGE_Rectangle(
			&SPA_RECTANGLE(width_def, height_def),
			&SPA_RECTANGLE(1, 1),
			&SPA_RECTANGLE(8192, 8192)),
		SPA_FORMAT_VIDEO_framerate, SPA_POD_CHOICE_RANGE_Fraction(
			&SPA_FRACTION(fps_val, 1),
			&SPA_FRACTION(0, 1),
			&SPA_FRACTION(1000, 1)),
		0);

	int res = pw_stream_connect(data.stream,
	                            PW_DIRECTION_INPUT,
	                            PW_ID_ANY,
	                            PW_STREAM_FLAG_AUTOCONNECT |
	                            PW_STREAM_FLAG_MAP_BUFFERS |
	                            PW_STREAM_FLAG_DONT_RECONNECT,
	                            params, 1);

	if (res < 0) {
		fprintf(stderr, "[pw_stream] Failed to connect stream to target '%s': %s\n",
		        data.target_node, spa_strerror(res));
		if (data.tj) tjDestroy(data.tj);
		pw_stream_destroy(data.stream);
		pw_core_disconnect(data.core);
		pw_context_destroy(data.context);
		pw_main_loop_destroy(data.loop);
		if (data.close_out_fd) close(data.out_fd);
		return 1;
	}

	fprintf(stderr, "[pw_stream] Connected, capturing from node '%s'...\n", data.target_node);

	pw_main_loop_run(data.loop);

	fprintf(stderr, "[pw_stream] Exiting. Total frames: %lu, dropped: %lu\n",
	        (unsigned long)data.total_frames, (unsigned long)data.dropped_frames);

	if (data.tj) {
		tjDestroy(data.tj);
		data.tj = NULL;
	}
	pw_stream_destroy(data.stream);
	pw_core_disconnect(data.core);
	pw_context_destroy(data.context);
	pw_main_loop_destroy(data.loop);
	pw_deinit();

	if (data.close_out_fd && data.out_fd >= 0) {
		close(data.out_fd);
	}

	return 0;
}
