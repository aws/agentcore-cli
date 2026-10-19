def handler(event, context):
    return {"message": event.get("message", "")}
