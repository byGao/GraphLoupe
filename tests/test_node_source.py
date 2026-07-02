"""P1-1 R-01: worker._node_sources resolves each node's def file:line via inspect,
and omits the synthetic __start__/__end__ nodes."""
import functools
import inspect

from graphloupe_sidecar import graph, worker


def test_node_sources_resolves_file_and_def_line():
    g = graph.build_graph().get_graph()
    sources = worker._node_sources(g)

    assert set(sources) == {"prepare", "llm"}
    for ref in sources.values():
        assert ref.file.endswith("graph.py")
        assert ref.line > 0

    # the reported line is the def line of that node's own function
    graph_src = inspect.getsource(graph).splitlines()
    assert "def prepare" in graph_src[sources["prepare"].line - 1]
    assert "def llm" in graph_src[sources["llm"].line - 1]


def test_node_sources_omits_synthetic_nodes():
    g = graph.build_graph().get_graph()
    sources = worker._node_sources(g)
    assert "__start__" not in sources
    assert "__end__" not in sources


def test_source_fn_follows_wraps():
    """A sync node wrapped with functools.wraps resolves to the user's function
    (langgraph wraps sync nodes; __wrapped__ points at the real def, not the wrapper)."""
    def real(state):
        return state

    @functools.wraps(real)
    def wrapper(state):
        return real(state)

    assert worker._source_fn(wrapper) is real


def test_source_fn_peels_partial_to_user_fn():
    """langgraph runs a sync node as partial(run_in_executor, None, user_fn); partial.func
    is the langchain wrapper, so we must pick the user function from the partial args."""
    def real(state):
        return state

    def runner(config, fn, *args):
        return fn(*args)

    node = functools.partial(runner, None, real)
    assert worker._source_fn(node) is real
