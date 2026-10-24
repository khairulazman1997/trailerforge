from .rpc import RpcServer


def main() -> None:
    server = RpcServer()

    def music(params, progress):
        from .music import analyze_music

        return analyze_music(params, progress)

    def footage(params, progress):
        from .footage import analyze_footage

        return analyze_footage(params, progress)

    def frames(params, progress):
        from .vision import embed_frames

        return embed_frames(params, progress)

    def texts(params, progress):
        from .vision import embed_texts

        return embed_texts(params, progress)

    # Heavy libraries load on first use, so `ping` answers at once.
    server.register("analyze.music", music, progress=True)
    server.register("analyze.footage", footage, progress=True)
    server.register("vision.embed_frames", frames, progress=True)
    server.register("vision.embed_texts", texts, progress=True)
    server.serve()


if __name__ == "__main__":
    main()
