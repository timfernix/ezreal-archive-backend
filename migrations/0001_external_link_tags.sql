CREATE TABLE IF NOT EXISTS external_link_tags (
    external_link_id INTEGER,
    tag_id INTEGER,
    PRIMARY KEY(external_link_id, tag_id),
    FOREIGN KEY(external_link_id) REFERENCES external_links(id) ON DELETE CASCADE,
    FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
);
