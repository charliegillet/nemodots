def split_csv_line(line: str, delimiter: str = ",") -> list[str]:
    """Split one CSV line into fields, honouring double-quoted fields."""
    if len(delimiter) != 1 or delimiter == '"':
        raise ValueError("delimiter must be a single character other than '\"'")
    fields: list[str] = []
    i = 0
    n = len(line)
    while True:
        if i < n and line[i] == '"':
            i += 1
            buf: list[str] = []
            while True:
                if i >= n:
                    raise ValueError("unterminated quoted field")
                ch = line[i]
                if ch == '"':
                    if i + 1 < n and line[i + 1] == '"':
                        buf.append('"')
                        i += 2
                        continue
                    i += 1
                    break
                buf.append(ch)
                i += 1
            fields.append("".join(buf))
            if i == n:
                return fields
            if line[i] != delimiter:
                raise ValueError(f"unexpected character {line[i]!r} after closing quote")
            i += 1
        else:
            j = line.find(delimiter, i)
            if j == -1:
                fields.append(line[i:])
                return fields
            fields.append(line[i:j])
            i = j + 1
