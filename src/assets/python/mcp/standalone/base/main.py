from mcp.server.fastmcp import FastMCP
import uvicorn

mcp = FastMCP("{{ name }}")


@mcp.tool()
def add_numbers(a: int, b: int) -> int:
    """Return the sum of two numbers."""
    return a + b


@mcp.tool()
def greet(name: str) -> str:
    """Return a greeting for the given name."""
    return f"Hello, {name}!"


if __name__ == "__main__":
    uvicorn.run(
        mcp.streamable_http_app(),
        host="0.0.0.0",
        port=8000,
    )
